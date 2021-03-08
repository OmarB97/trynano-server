#!/bin/bash

rm -f lambda.zip
zip lambda.zip -r index.js .env node_modules
