#!/usr/bin/env node
import "source-map-support/register.js";

import * as cdk from "aws-cdk-lib";

import { HostedSymphonyStack } from "../lib/hosted-symphony-stack.js";

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";
const domainName = app.node.tryGetContext("domainName");
const hostedZoneId = app.node.tryGetContext("hostedZoneId");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const imageTag = app.node.tryGetContext("imageTag") ?? "latest";

for (const environmentName of ["staging", "prod"] as const) {
  new HostedSymphonyStack(app, `HostedSymphony-${environmentName}`, {
    env: {
      account,
      region,
    },
    environmentName,
    domainName,
    hostedZoneId,
    hostedZoneName,
    imageTag,
  });
}
