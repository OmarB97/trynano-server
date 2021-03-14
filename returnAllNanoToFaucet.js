const AWS = require('aws-sdk');
const nano_client = require('@nanobox/nano-client');

require('dotenv').config();

const PUBLIC_KEY = process.env.PUBLIC_KEY,
  PRIVATE_KEY = process.env.PRIVATE_KEY,
  FAUCET_ADDRESS = process.env.ADDRESS,
  NANOBOX_USER = process.env.NANOBOX_USER,
  NANOBOX_PASSWORD = process.env.NANOBOX_PASSWORD;

const DDB_WALLET_TABLE_NAME = 'TryNanoWallets';

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

exports.handler = async (event) => {
  try {
    console.log(`event: ${JSON.stringify(event)}`);

    const error = validateState();
    if (error) {
      return response(500, { error: error });
    }

    // Get Faucet account info to check things like the current balance
    const accountInfo = await c.updateWalletAccount({
      address: FAUCET_ADDRESS,
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
    });

    if (!accountInfo) {
      return response(500, { error: `unable to retrieve faucet account info` });
    }

    // get all accounts with ts > 7 days (1 minute for dev testing)

    const res = await getAllEligibleAccounts();

    // const res = await c.send(
    //   {
    //     address: FAUCET_ADDRESS,
    //     publicKey: PUBLIC_KEY,
    //     privateKey: PRIVATE_KEY,
    //   },
    //   params.toAddress,
    //   NANO.fromNumber(accountInfo.balance.asNumber * FAUCET_PERCENT)
    // );
    // if (!res) {
    //   return response(500, {
    //     error: `unable to send from ${FAUCET_ADDRESS} to ${params.toAddress}`,
    //   });
    // }

    const response = {
      statusCode: 200,
      body: JSON.stringify(
        'All eligible nano accounts emptied into faucet + removed DB records'
      ),
    };
    return response;
  } catch (err) {
    console.log(`caught error: ${err.message}`);
    return response(500, { error: 'Server error, please try again later!' });
  }
};

/**
 * Get all eligible logged nano accounts with timestamp > 7 days.
 *
 * @returns List of eligible Nano accounts with their info: walletID, publicKey, and privateKey
 */
async function getAllEligibleAccounts() {
  const res = await ddb
    .scan({
      TableName: DDB_WALLET_TABLE_NAME,
      ProjectionExpression:
        'walletID, publicKey, privateKey, balance, expirationTs',
      FilterExpression: 'balance > :z',
      ExpressionAttributeValues: {
        ':z': { N: '0' },
      },
    })
    .promise();

  console.log(`res: ${JSON.stringify(res)}`);

  if (!res.Items) {
    return null;
  }

  res.Items.forEach(async (item) => {
    // wallets.push(AWS.DynamoDB.Converter.unmarshall(item));
    const wallet = AWS.DynamoDB.Converter.unmarshall(item);
    const nanoAccount = {
      address: wallet.walletID,
      publicKey: wallet.publicKey,
      privateKey: wallet.privateKey,
    };

    // now send all the nano in this wallet to the faucet
    const sendRes = await c.sendMax(nanoAccount, FAUCET_ADDRESS);
    const updatedBalance = sendRes.balance.asString;

  });

  //   const updatedBalance = sendRes.balance.asString;
  // console.log(`updatedBalance: ${updatedBalance}`);

  //   console.log(`wallets: ${JSON.stringify(wallets)}`);
  return true;

  //   const wallet = AWS.DynamoDB.Converter.unmarshall(res.Item);
  //   const nanoAccount = {
  //     address: wallet.walletID,
  //     publicKey: wallet.publicKey,
  //     privateKey: wallet.privateKey,
  //   };
  //   return nanoAccount;
}

/**
 * Receives any pending transactions for the TryNano faucet
 *
 * @param {APIGatewayProxyEvent} _event the API Gateway event data
 * @param {Object} _params the http request body data
 * @returns the faucet address, the updated balance, and the number of resolved pending transactions
 */
async function receivePendingFaucetTransactions(_event, _params) {
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
  } else if (!NANOBOX_USER) {
    return 'NANOBOX_USER key missing from .env - you must fix';
  } else if (!NANOBOX_PASSWORD) {
    return 'NANOBOX_PASSWORD key missing from .env - you must fix';
  }

  return null;
}