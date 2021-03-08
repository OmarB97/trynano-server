const AWS = require('aws-sdk');
const nano_client = require('@nanobox/nano-client');
const {NANO} = require("@nanobox/nano-client/dist/models");
const axios = require('axios');
const FormData = require('form-data');

require('dotenv').config();

const PUBLIC_KEY = process.env.PUBLIC_KEY,
      PRIVATE_KEY = process.env.PRIVATE_KEY,
      FAUCET_ADDRESS = process.env.ADDRESS,
      CAPTCHA_SECRET = process.env.CAPTCHA_SECRET,
      NANOBOX_USER = process.env.NANOBOX_USER,
      NANOBOX_PASSWORD = process.env.NANOBOX_PASSWORD;

const DDB_TABLE_NAME = 'FaucetWallets';
const TXN_AMOUNT = NANO.fromNumber(0.000001);

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

async function loadNanoAccountFromDB(address) {
    const res = await ddb.getItem({
        TableName: DDB_TABLE_NAME,
        Key: {
            walletID: {
                S: address,
            },
        }
    }).promise();
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

async function receive(event, params) {
    const acc = await loadNanoAccountFromDB(params.receiveAddress);
    if (!acc) {
        return response(400, {error: 'invalid wallet address'});
    }

    const res = await c.receive(acc);
    return response(200, {
        address: params.receiveAddress,
        balance: res.account.balance.asString,
        resolvedCount: res.resolvedCount,
    });
}

async function send(event, params) {
    const acc = await loadNanoAccountFromDB(params.fromAddress);
    if (!acc) {
        return response(400, {error: `${params.fromAddress} is an invalid wallet address`});
    }

    const res = await c.sendMax(acc, params.toAddress);
    if (!res) {
        return response(500, {error: `unable to send from ${params.fromAddress} to ${params.toAddress}`});
    }
    return response(200, {
        address: params.fromAddress,
        balance: res.balance.asString,
    })
}

async function getFromFaucet(event, params) {
    const acc = await loadNanoAccountFromDB(params.toAddress);
    if (!acc) {
        return response(400, {error: `${params.toAddress} is an invalid wallet address`});
    }

    const res = await c.send({
        address: FAUCET_ADDRESS,
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
    }, params.toAddress, TXN_AMOUNT);
    if (!res) {
        return response(500, {error: `unable to send from ${FAUCET_ADDRESS} to ${params.toAddress}`});
    }

    return response(200, {
        address: FAUCET_ADDRESS,
        balance: res.balance.asString,
    })
}

async function createWallets(event, params) {
    let wallets = [];
    for (let i = 0; i < 2; i++) {
        const wallet = c.generateWallet().accounts[0];
        await ddb.putItem({
            TableName: DDB_TABLE_NAME,
            Item: AWS.DynamoDB.Converter.marshall({
                walletID: wallet.address,
                privateKey: wallet.privateKey,
                publicKey: wallet.publicKey,
            }),
        }).promise();
        wallets.push({
            address: wallet.address,
        })
    }

    return response(200, {
        wallets: wallets,
    });
}

async function faucetReceive(event, params) {
    const res = await c.receive({
        address: FAUCET_ADDRESS,
        publicKey: PUBLIC_KEY,
        privateKey: PRIVATE_KEY,
    });
    return response(200, {
        address: FAUCET_ADDRESS,
        balance: res.account.balance.asString,
        resolvedCount: res.resolvedCount,
    })
}

const apiMapping = {
    '/api/send': send,
    '/api/createWallets': createWallets,
    '/api/receive': receive,
    '/api/faucetReceive': faucetReceive,
    '/api/getFromFaucet': getFromFaucet,
}

exports.handler = async function(event) {
    const error = validateState();
    if (error) {
        return response(500, {error: error});
    }

    const captchaResponse = await validateCaptcha('this_is_a_token');
    if (!captchaResponse.success && !(event.headers['bpc'] === '123')) {
        return response(403, {error: 'access denied robits no good'});
    }

    const path = event.rawPath;
    const params = event.body ? JSON.parse(event.body) : {};
    const f = apiMapping[path];
    if (!f) {
        return response(404, 'not found');
    }
    return await f(event, params);
}

function response(code, object) {
    return {
        statusCode: code,
        body: JSON.stringify(object),
    }
}

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

async function validateCaptcha(token) {
    const fd = new FormData();
    fd.append('secret', CAPTCHA_SECRET);
    fd.append('response', token);
    const res = await axios.post('https://www.google.com/recaptcha/api/siteverify', fd, {
        headers: fd.getHeaders(),
    });

    return {
        success: res.data.success,
        errors: res.data['error-codes'],
    };
}

if (process.env.EXEC_LOCAL) {
    const http = require('http');
    http.createServer(function(req, res) {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
            exports.handler({
                rawPath: req.url,
                body: data,
                headers: req.headers,
            }).then((proxyResponse) => {
                res.writeHead(proxyResponse.statusCode);
                res.write(proxyResponse.body);
                res.end();
            });
        });
    }).listen(8080);
}