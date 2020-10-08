"use strict";
const _ = require("lodash");
const BbPromise = require("bluebird");
const AWS = require("aws-sdk");
const path = require('path');
const stepfunctionsLocal = require('./stepfunctions-local')

class ServerlessStepfunctionsLocal {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.service = serverless.service;
        this.serverlessLog = serverless.cli.log.bind(serverless.cli);
        this.config = this.service.custom && this.service.custom.stepfunctions || {};
        this.options = _.merge({
            localPath: serverless.config && path.join(serverless.config.servicePath, '.stepfunctions')
        },
            options
        );
        this.provider = "aws";
        this.commands = {
            stepfunctions: {
                commands: {
                    start: {
                        lifecycleEvents: ["startHandler"],
                        usage: "Starts local DynamoDB",
                        options: {
                            port: {
                                shortcut: "p",
                                usage: "The port number that DynamoDB will use to communicate with your application. If you do not specify this option, the default port is 8083"
                            },
                        }
                    },
                    install: {
                        usage: "Installs local StepFunctions",
                        lifecycleEvents: ["installHandler"],
                        options: {
                            localPath: {
                                shortcut: "x",
                                usage: "Local stepfunctions install path"
                            }
                        }

                    }
                }
            }
        };

        this.hooks = {
            "stepfunctions:install:installHandler": this.installHandler.bind(this),
            "stepfunctions:start:startHandler": this.startHandler.bind(this),
            "before:offline:start:init": this.startHandler.bind(this),
            "before:offline:start:end": this.endHandler.bind(this),
        };
    }

    get port() {
        return 8083;
    }

    get host() {
        const config = this.service.custom && this.service.custom.dynamodb || {};
        const host = _.get(config, "start.host", "localhost");
        return host;
    }

    /**
     * Get the stage
     *
     * @return {String} the current stage
     */
    get stage() {
        return (this.options && this.options.stage) || (this.service.provider && this.service.provider.stage);
    }

    // dynamodbOptions(options) {
    //     let dynamoOptions = {};

    //     if (options && options.online) {
    //         this.serverlessLog("Connecting to online tables...");
    //         if (!options.region) {
    //             throw new Error("please specify the region");
    //         }
    //         dynamoOptions = {
    //             region: options.region,
    //             convertEmptyValues: options && options.convertEmptyValues ? options.convertEmptyValues : false,
    //         };
    //     } else {
    //         dynamoOptions = {
    //             endpoint: `http://${this.host}:${this.port}`,
    //             region: "localhost",
    //             accessKeyId: "MOCK_ACCESS_KEY_ID",
    //             secretAccessKey: "MOCK_SECRET_ACCESS_KEY",
    //             convertEmptyValues: options && options.convertEmptyValues ? options.convertEmptyValues : false,
    //         };
    //     }

    //     return {
    //         raw: new AWS.DynamoDB(dynamoOptions),
    //         doc: new AWS.DynamoDB.DocumentClient(dynamoOptions)
    //     };
    // }


    removeHandler() {
        return new BbPromise((resolve) => stepfunctionsLocal.remove(resolve));
    }

    installHandler() {
        const options = this.options;
        return new BbPromise((resolve) => stepfunctionsLocal.install(resolve, options.localPath));
    }

    startHandler() {
        const config = this.service.custom && this.service.custom.stepfunctions || {};
        const options = _.merge({
            install_path: this.options.localPath
        },
            config && config.start,
            this.options,
            { lambdaEndpoint: 'http://localhost:' + this.service.custom['serverless-offline'].port }
        );

        // otherwise endHandler will be mis-informed
        this.options = options;

        stepfunctionsLocal.start(options);
        return BbPromise.resolve()
    }

    seedHandler() {
        const recursivelyReplace = (obj) => {
            if ('States' in obj) {
                return { ...obj, States: Object.fromEntries(Object.entries(obj.States).map((entry) => [entry[0], recursivelyReplace(entry[1])])) }
            }
            if ('Resouce' in obj && ('Fn::GetAtt' in obj.Resource)) {
                return { ...obj, Resource: `arn:aws:lambda:us-east-1:123456789012:function:${obj.Resource['Fn::GetAtt'][0]}` }
            }

            if ('Resouce' in obj && ('!GetAtt' in obj.Resource)) {
                return { ...obj, Resource: `arn:aws:lambda:us-east-1:123456789012:function:${obj.Resource['!GetAtt'][0]}` }
            }
            return obj
        }

        const definitions = _.get(this.service, 'stepFunctions.stateMachines', {})
        Object.values(definitions).map(defs => {
            const name = defs.name
            const definition = recursivelyReplace(defs.definition)
            console.log(name, definition)
        })
    }



    endHandler() {
        this.serverlessLog("DynamoDB - stopping local database");
        stepfunctionsLocal.stop(this.port);
    }

    getDefaultStack() {
        return _.get(this.service, "resources");
    }

    getAdditionalStacks() {
        return _.values(_.get(this.service, "custom.additionalStacks", {}));
    }

    hasAdditionalStacksPlugin() {
        return _.get(this.service, "plugins", []).includes("serverless-plugin-additional-stacks");
    }

    getTableDefinitionsFromStack(stack) {
        const resources = _.get(stack, "Resources", []);
        return Object.keys(resources).map((key) => {
            if (resources[key].Type === "AWS::DynamoDB::Table") {
                return resources[key].Properties;
            }
        }).filter((n) => n);
    }

    /**
     * Gets the table definitions
     */
    get tables() {
        let stacks = [];

        const defaultStack = this.getDefaultStack();
        if (defaultStack) {
            stacks.push(defaultStack);
        }

        if (this.hasAdditionalStacksPlugin()) {
            stacks = stacks.concat(this.getAdditionalStacks());
        }

        return stacks.map((stack) => this.getTableDefinitionsFromStack(stack)).reduce((tables, tablesInStack) => tables.concat(tablesInStack), []);
    }

    /**
     * Gets the seeding sources
     */
    get seedSources() {
        const config = this.service.custom.dynamodb;
        const seedConfig = _.get(config, "seed", {});
        const seed = this.options.seed || config.start.seed || seedConfig;
        let categories;
        if (typeof seed === "string") {
            categories = seed.split(",");
        } else if (seed) {
            categories = Object.keys(seedConfig);
        } else { // if (!seed)
            this.serverlessLog("DynamoDB - No seeding defined. Skipping data seeding.");
            return [];
        }
        const sourcesByCategory = categories.map((category) => seedConfig[category].sources);
        return [].concat.apply([], sourcesByCategory);
    }

    createTable(dynamodb, migration) {
        return new BbPromise((resolve, reject) => {
            if (migration.StreamSpecification && migration.StreamSpecification.StreamViewType) {
                migration.StreamSpecification.StreamEnabled = true;
            }
            if (migration.TimeToLiveSpecification) {
                delete migration.TimeToLiveSpecification;
            }
            if (migration.SSESpecification) {
                migration.SSESpecification.Enabled = migration.SSESpecification.SSEEnabled;
                delete migration.SSESpecification.SSEEnabled;
            }
            if (migration.PointInTimeRecoverySpecification) {
                delete migration.PointInTimeRecoverySpecification;
            }
            if (migration.Tags) {
                delete migration.Tags;
            }
            if (migration.BillingMode === "PAY_PER_REQUEST") {
                delete migration.BillingMode;

                const defaultProvisioning = {
                    ReadCapacityUnits: 5,
                    WriteCapacityUnits: 5
                };
                migration.ProvisionedThroughput = defaultProvisioning;
                if (migration.GlobalSecondaryIndexes) {
                    migration.GlobalSecondaryIndexes.forEach((gsi) => {
                        gsi.ProvisionedThroughput = defaultProvisioning;
                    });
                }
            }
            dynamodb.raw.createTable(migration, (err) => {
                if (err) {
                    if (err.name === 'ResourceInUseException') {
                        this.serverlessLog(`DynamoDB - Warn - table ${migration.TableName} already exists`);
                        resolve();
                    } else {
                        this.serverlessLog("DynamoDB - Error - ", err);
                        reject(err);
                    }
                } else {
                    this.serverlessLog("DynamoDB - created table " + migration.TableName);
                    resolve(migration);
                }
            });
        });
    }
}
module.exports = ServerlessStepfunctionsLocal;

const recursivelyReplace = (obj) => {
    if ('States' in obj) {
        return { ...obj, States: Object.fromEntries(Object.entries(obj.States).map((entry) => [entry[0], recursivelyReplace(entry[1])])) }
    }
    if ('Resouce' in obj && ('Fn::GetAtt' in obj.Resource)) {
        return { ...obj, Resource: `arn:aws:lambda:us-east-1:123456789012:function:${obj.Resource['Fn::GetAtt'][0]}` }
    }

    if ('Resouce' in obj && ('!GetAtt' in obj.Resource)) {
        return { ...obj, Resource: `arn:aws:lambda:us-east-1:123456789012:function:${obj.Resource['!GetAtt'][0]}` }
    }
    return obj
}
