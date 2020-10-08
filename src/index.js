"use strict";
const _ = require("lodash");
const BbPromise = require("bluebird");
const AWS = require("aws-sdk");
const path = require('path');
const stepfunctionsLocal = require('./stepfunctions-local')


class ServerlessStepfunctionsLocal {

  get stepFunctionsConfig() {
    return {
      "setup": {
        "download_url": "https://docs.aws.amazon.com/ja_jp/step-functions/latest/dg/samples/StepFunctionsLocal.tar.gz",
        "install_path": this.options.localPath,
        "jar": "StepFunctionsLocal.jar"
      },
      "start": {
        "port": 3003
      }
    }
  }

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
            usage: "Starts local StepFunctions",
            options: {
              port: {
                shortcut: "p",
                usage: "The port number that StepFunctions will use to communicate with your application. If you do not specify this option, the default port is 8083"
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
    const config = this.service.custom && this.service.custom.StepFunctions || {};
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

  removeHandler() {
    return new BbPromise((resolve) => stepfunctionsLocal.remove(resolve));
  }

  installHandler() {
    return new BbPromise((resolve) => stepfunctionsLocal.install(this.stepFunctionsConfig, resolve));
  }

  async startHandler() {
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

    stepfunctionsLocal.start(options, this.stepFunctionsConfig);
    await this.seedHandler()
    return
  }

  async seedHandler() {
    const recursivelyReplace = (obj) => {
      if ('States' in obj) {
        return { ...obj, States: Object.fromEntries(Object.entries(obj.States).map((entry) => [entry[0], recursivelyReplace(entry[1])])) }
      }
      if ('Iterator' in obj) {
        return { ...obj, Iterator: { ...obj.Iterator, States: Object.fromEntries(Object.entries(obj.Iterator.States).map((entry) => [entry[0], recursivelyReplace(entry[1])])) } }
      }
      if ('Resource' in obj && ('Fn::GetAtt' in obj.Resource)) {
        return { ...obj, Resource: `arn:aws:lambda:us-east-1:123456789012:function:${obj.Resource['Fn::GetAtt'][0]}` }
      }

      if ('Resource' in obj && ('!GetAtt' in obj.Resource)) {
        return { ...obj, Resource: `arn:aws:lambda:us-east-1:123456789012:function:${obj.Resource['!GetAtt'][0]}` }
      }
      return obj
    }

    const definitions = _.get(this.service, 'initialServerlessConfig.stepFunctions.stateMachines', {})
    await Promise.all(Object.values(definitions).map(defs => {
      const name = defs.name
      const definition = recursivelyReplace(defs.definition)
      return new AWS.StepFunctions({
        endpoint: "http://localhost:8083",
        region: "us-east-1"
      }).createStateMachine({
        definition: JSON.stringify(definition),
        name,
        roleArn: "arn:aws:iam::012345678901:role/DummyRole",
      }).promise()
    }))
  }



  endHandler() {
    this.serverlessLog("StepFunctions - stopping local database");
    stepfunctionsLocal.stop(this.port);
  }

}
module.exports = ServerlessStepfunctionsLocal;

