'use strict';

var spawn = require('child_process').spawn,
    utils = require('./utils');

var starter = {
    start: function (options, config) {
        /* Dynamodb local documentation http://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html */
        var preArgs = [],
            additionalArgs = [],
            stepfunctions_dir = options.install_path || utils.absPath(config.setup.install_path),
            jar = config.setup.jar;

        var args = ['-jar', jar, '-lambdaEndpoint', options.lambdaEndpoint];
        args = preArgs.concat(args.concat(additionalArgs));

        var child = spawn('java', args, {
            cwd: stepfunctions_dir,
            env: process.env,
            stdio: ['pipe', 'pipe', process.stderr]
        });

        if (!child.pid) {
            throw new Error('Unable to start DynamoDB Local process! Make sure you have java executable in your path.');
        }

        child.on('error', function (code) {
            throw new Error(code);
        });

        child.on('data', (d) => {
            console.log(d)
        })

        return {
            proc: child,
            port: 8083
        };
    },
};

module.exports = starter;