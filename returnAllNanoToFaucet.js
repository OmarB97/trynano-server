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

    const previousFaucetBalance = accountInfo.balance.asString;

    // Try to return all non-zero nano balances back to the TryNano faucet
    const returnToFaucetRes = await returnAllNanoToFaucet();
    if (returnToFaucetRes.error) {
      return response(500, {
        error: returnToFaucetRes.error,
      });
    }

    // Confirm any pending faucet transactions so the balance is fully up to date
    const receiveRes = await receivePendingFaucetTransactions();
    if (receiveRes.error) {
      return response(500, {
        error: receiveRes.error,
      });
    }

    return response(200, {
      walletCount: returnToFaucetRes.walletCount,
      previousFaucetBalance: previousFaucetBalance,
      updatedFaucetBalance: receiveRes.updatedFaucetBalance,
      resolvedCount: receiveRes.resolvedCount,
    });
  } catch (err) {
    console.log(`caught error: ${err.message}`);
    return response(500, { error: err.message });
  }
};

/**
 * Get all non-zero balance nano accounts and sends all their nano to the TryNano faucet.
 *
 * @returns Wallet count if successful, error if not successful
 */
async function returnAllNanoToFaucet() {
  const res = await ddb
    .scan({
      TableName: DDB_WALLET_TABLE_NAME,
      ProjectionExpression: 'walletID, publicKey, privateKey, balance',
      FilterExpression: 'balance > :z',
      ExpressionAttributeValues: {
        ':z': { N: '0' },
      },
    })
    .promise();

  console.log(`res: ${JSON.stringify(res)}`);

  if (!res.Items) {
    return {
      error: 'database scan results were not defined',
    };
  }

  const sendNanoFromWallets = async () => {
    console.log('Start');
    await asyncForEach(res.Items, async (item) => {
      const wallet = AWS.DynamoDB.Converter.unmarshall(item);
      const nanoAccount = {
        address: wallet.walletID,
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
      };

      // now send all the nano in this wallet to the faucet
      const sendRes = await c.sendMax(nanoAccount, FAUCET_ADDRESS);
      if (!sendRes) {
        return {
          error: 'send operation returned undefined',
        };
      }
      const updatedBalance = sendRes.balance.asString;

      // finally, update the wallet balance in the database
      await updateNanoBalanceInDB(nanoAccount.address, updatedBalance);
    });
    console.log('Done');
  };

  // run async/await on a loop to wait for all wallets to send their nano
  await sendNanoFromWallets();

  return {
    walletCount: res.Count,
  };
}

/**
 * Updates the balance for a TryNano wallet in DynamoDB.
 *
 * @param {string} address the address of the nano account
 * @param {string} updatedBalance the updated wallet balance
 */
async function updateNanoBalanceInDB(address, updatedBalance) {
  await ddb
    .updateItem({
      TableName: DDB_WALLET_TABLE_NAME,
      Key: {
        walletID: {
          S: address,
        },
      },
      UpdateExpression: 'SET balance = :u',
      ExpressionAttributeValues: {
        ':u': {
          N: updatedBalance,
        },
      },
      ReturnValues: 'UPDATED_NEW',
    })
    .promise();
}

/**
 * Receives any pending transactions for the TryNano faucet
 *
 * @returns The updated faucet balance, and the number of resolved pending transactions
 */
async function receivePendingFaucetTransactions() {
  const res = await c.receive({
    address: FAUCET_ADDRESS,
    publicKey: PUBLIC_KEY,
    privateKey: PRIVATE_KEY,
  });

  if (res.error) {
    return {
      error: res.error,
    };
  }

  return {
    updatedFaucetBalance: res.account.balance.asString,
    resolvedCount: res.resolvedCount,
  };
}

/**
 * Constructs an HttpResponse object.
 *
 * @param {HttpStatus} code HTTP response status code
 * @param {Object} body response body
 * @returns {HttpResponse} HTTP response object
 */
function response(code, body) {
  return {
    statusCode: code,
    body: body,
  };
}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
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
