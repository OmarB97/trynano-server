const AWS = require('aws-sdk');
const nano_client = require('@nanobox/nano-client');
const { NANO } = require('@nanobox/nano-client/dist/models');
const axios = require('axios');
const FormData = require('form-data');
const { HttpResponse } = require('aws-sdk');

require('dotenv').config();

const PUBLIC_KEY = process.env.PUBLIC_KEY,
  PRIVATE_KEY = process.env.PRIVATE_KEY,
  FAUCET_ADDRESS = process.env.ADDRESS,
  CAPTCHA_SECRET = process.env.CAPTCHA_SECRET,
  NANOBOX_USER = process.env.NANOBOX_USER,
  NANOBOX_PASSWORD = process.env.NANOBOX_PASSWORD;

const DDB_TABLE_NAME = 'FaucetWallets';
const FAUCET_PERCENT = 0.00015;

const c = new nano_client.NanoClient({
  url: 'https://api.nanobox.cc',
  credentials: {
    username: NANOBOX_USER,
    password: NANOBOX_PASSWORD,
  },
});

const ddb = new AWS.DynamoDB({
  region: 'us-west-1',
});

const apiMapping = {
  '/api/createWallets': createWallets,
  '/api/send': send,
  '/api/receive': receive,
  '/api/getFromFaucet': getFromFaucet,
  '/api/receivePendingFaucetTransactions': receivePendingFaucetTransactions,
};

/**
 * Entry-point for the AWS Lambda function. Checks recaptcha token and reroutes to appropriate api method based off the requested path.
 *
 * @param {APIGatewayProxyEvent} event the API Gateway event data
 * @returns {HttpResponse} Http response object
 */
exports.handler = async function (event) {
  if (event.requestContext.http.method === 'OPTIONS') {
    return response(200, {});
  }

  const error = validateState();
  if (error) {
    return response(500, { error: error });
  }

  const token = event.headers['x-recaptcha'];
  const captchaResponse = token ? await validateCaptcha(token) : undefined;
  if (!(captchaResponse && captchaResponse.success)) {
    return response(403, { error: 'access denied: invalid recaptcha token' });
  }

  const path = event.rawPath;
  const params = event.body ? JSON.parse(event.body) : {};
  const apiMethod = apiMapping[path];
  if (!apiMethod) {
    return response(404, 'not found');
  }
  return await apiMethod(event, params);
};

/**
 * Generates two brand new TryNano wallets and logs the wallet info to DynamoDB.
 *
 * @param {APIGatewayProxyEvent} event the API Gateway event data
 * @param {Object} params the http request body data
 * @returns a list of two generated wallets with their corresponding address, privateKey, and balance (starts at 0)
 */
async function createWallets(event, params) {
  let wallets = [];
  for (let i = 0; i < 2; i++) {
    const wallet = c.generateWallet().accounts[0];
    await ddb
      .putItem({
        TableName: DDB_TABLE_NAME,
        Item: AWS.DynamoDB.Converter.marshall({
          walletID: wallet.address,
          privateKey: wallet.privateKey,
          publicKey: wallet.publicKey,
        }),
      })
      .promise();
    wallets.push({
      address: wallet.address,
      privateKey: wallet.privateKey,
      balance: { raw: '0' },
    });
  }

  return response(200, {
    wallets: wallets,
  });
}

/**
 * Sends either the max account balance or a specified amount of nano from one nano account to another.
 *
 * @param {APIGatewayProxyEvent} event the API Gateway event data
 * @param {Object} params the http request body data
 * @returns the sender address, updated sender account balance , and starting timestamp of the send transaction
 */
async function send(event, params) {
  const acc = await loadNanoAccountFromDB(params.fromAddress);
  if (!acc) {
    return response(400, {
      error: `${params.fromAddress} is an invalid wallet address`,
    });
  }

  // Extra security measure to prove the wallet was generated by the user sending the nano
  if (params.privateKey !== acc.privateKey) {
    return response(400, {
      error: `invalid private key for wallet address ${params.fromAddress}`,
    });
  }

  const accountInfo = await c.updateWalletAccount({
    address: acc.address,
    publicKey: acc.publicKey,
    privateKey: acc.privateKey,
  });

  if (!accountInfo) {
    return response(500, {
      error: `unable to retrieve account info for address sending Nano`,
    });
  }

  if (accountInfo.balance.asNumber === 0) {
    return response(400, {
      error: `wallet balance is zero`,
    });
  }

  const ts = Date.now();

  let res;
  if (params.amount) {
    if (params.amount.asString === '0') {
      return response(400, {
        error: 'Unable to send zero amount of Nano',
      });
    }
    res = await c.send(acc, params.toAddress, params.amount);
  } else {
    res = await c.sendMax(acc, params.toAddress);
  }
  if (!res) {
    return response(500, {
      error: `unable to send from ${params.fromAddress} to ${params.toAddress}`,
    });
  }
  return response(200, {
    address: params.fromAddress,
    balance: res.balance.asString,
    sendTimestamp: ts,
  });
}

/**
 * Receives all pending transactions for a given nano account.
 *
 * @param {APIGatewayProxyEvent} event the API Gateway event data
 * @param {Object} params the http request body data
 * @returns the address, updated account balance, and resolved count for the given nano account.
 */
async function receive(event, params) {
  const acc = await loadNanoAccountFromDB(params.receiveAddress);
  if (!acc) {
    return response(400, { error: 'invalid wallet address' });
  }

  const res = await c.receive(acc);
  return response(200, {
    address: params.receiveAddress,
    balance: res.account.balance.asString,
    resolvedCount: res.resolvedCount,
  });
}

/**
 * Sends a percentage of nano from the TryNano Faucet to the provided nano account.
 *
 * @param {APIGatewayProxyEvent} event the API Gateway event data
 * @param {Object} params the http request body data
 * @returns the faucet address and the updated faucet balance
 */
async function getFromFaucet(event, params) {
  const acc = await loadNanoAccountFromDB(params.toAddress);
  if (!acc) {
    return response(400, {
      error: `${params.toAddress} is an invalid wallet address`,
    });
  }

  // Extra security measure to prove the wallet was generated by the user requesting nano from the faucet
  if (params.privateKey !== acc.privateKey) {
    return response(400, {
      error: `invalid private key for wallet address ${params.toAddress}`,
    });
  }

  const accountInfo = await c.updateWalletAccount({
    address: FAUCET_ADDRESS,
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY,
  });

  if (!accountInfo) {
    return response(500, { error: `unable to retrieve faucet account info` });
  }

  const res = await c.send(
    {
      address: FAUCET_ADDRESS,
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    },
    params.toAddress,
    NANO.fromNumber(accountInfo.balance.asNumber * FAUCET_PERCENT)
  );
  if (!res) {
    return response(500, {
      error: `unable to send from ${FAUCET_ADDRESS} to ${params.toAddress}`,
    });
  }

  return response(200, {
    address: FAUCET_ADDRESS,
    balance: res.balance.asString,
  });
}

/**
 * Receives any pending transactions for the TryNano faucet
 *
 * @param {APIGatewayProxyEvent} event the API Gateway event data
 * @param {Object} params the http request body data
 * @returns the faucet address, the updated balance, and the number of resolved pending transactions
 */
async function receivePendingFaucetTransactions(event, params) {
  const res = await c.receive({
    address: FAUCET_ADDRESS,
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY,
  });
  return response(200, {
    address: FAUCET_ADDRESS,
    balance: res.account.balance.asString,
    resolvedCount: res.resolvedCount,
  });
}

/**
 * Constructs an HttpResponse object with the appropriate CORS headers.
 *
 * @param {HttpStatus} code HTTP response status code
 * @param {Object} body response body
 * @returns {HttpResponse} HTTP response object
 */
function response(code, body) {
  return {
    statusCode: code,
    headers: {
      'Access-Control-Allow-Headers': 'Content-Type, X-Recaptcha, X-Api-Key',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'OPTIONS,POST,GET',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Loads a TryNano generated wallet from DynamoDB.
 *
 * @param {string} address the address of the nano account
 * @returns The corresponding Nano account info: walletID, publicKey, and privateKey
 */
async function loadNanoAccountFromDB(address) {
  const res = await ddb
    .getItem({
      TableName: DDB_TABLE_NAME,
      Key: {
        walletID: {
          S: address,
        },
      },
    })
    .promise();
  if (!res.Item) {
    return null;
  }

  const wallet = AWS.DynamoDB.Converter.unmarshall(res.Item);
  const nanoAccount = {
    address: wallet.walletID,
    publicKey: wallet.publicKey,
    privateKey: wallet.privateKey,
  };
  return nanoAccount;
}

/**
 * Validates the recaptcha token attached to the request header.
 *
 * @param {string} token Google ReCaptchaV3 token
 */
async function validateCaptcha(token) {
  const fd = new FormData();
  fd.append('secret', CAPTCHA_SECRET);
  fd.append('response', token);
  const res = await axios.post(
    'https://www.google.com/recaptcha/api/siteverify',
    fd,
    {
      headers: fd.getHeaders(),
    }
  );

  return {
    success: res.data.success,
    errors: res.data['error-codes'],
  };
}

/**
 * Ensures all required environment variables are present.
 *
 * @returns {string} Error message
 */
function validateState() {
  if (!FAUCET_ADDRESS) {
    return 'ADDRESS key missing from .env - you must fix';
  } else if (!PUBLIC_KEY) {
    return 'PUBLIC_KEY key missing from .env - you must fix';
  } else if (!PRIVATE_KEY) {
    return 'PRIVATE_KEY key missing from .env - you must fix';
  } else if (!CAPTCHA_SECRET) {
    return 'CAPTCHA_SECRET key missing from .env - you must fix';
  } else if (!NANOBOX_USER) {
    return 'NANOBOX_USER key missing from .env - you must fix';
  } else if (!NANOBOX_PASSWORD) {
    return 'NANOBOX_PASSWORD key missing from .env - you must fix';
  }

  return null;
}
/* 
    Runs a lambda server locally
*/
if (process.env.EXEC_LOCAL) {
  const path = require('path');
  const lambdaLocal = require('lambda-local');
  const express = require('express');
  var cors = require('cors');
  var bodyParser = require('body-parser');
  const app = express();

  // Process body as plain text as this is
  // how it would come from API Gateway
  app.use(express.text());
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(cors());
  app.options('*', cors());
  app.use('/lambda', async (req, res) => {
    const result = await lambdaLocal.execute({
      lambdaPath: path.join(__dirname, 'index'),
      lambdaHandler: 'handler',
      envfile: path.join(__dirname, '.env'),
      event: {
        headers: req.headers, // Pass on request headers
        body: req.body, // Pass on request body
        rawPath: req.url, // Pass on requested resource url
      },
      timeoutMs: 30000,
    });

    // Respond to HTTP request
    res.status(result.statusCode).set(result.headers).end(result.body);
  });

  app.listen(3000, () => console.log('listening on port: 3000'));
}
