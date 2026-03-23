import * as cdk from "aws-cdk-lib";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as efs from "aws-cdk-lib/aws-efs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface HostedSymphonyStackProps extends StackProps {
  environmentName: "staging" | "prod";
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  imageTag: string;
}

export class HostedSymphonyStack extends Stack {
  constructor(scope: Construct, id: string, props: HostedSymphonyStackProps) {
    super(scope, id, props);

    const prefix = `hosted-symphony-${props.environmentName}`;
    const vpc = new ec2.Vpc(this, "Vpc", {
      natGateways: 1,
      maxAzs: 2,
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    const fileSystem = new efs.FileSystem(this, "WorkspaceFileSystem", {
      vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DbSecurityGroup", { vpc });
    const appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", { vpc });
    dbSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(5432));
    fileSystem.connections.allowDefaultPortFrom(appSecurityGroup);

    const dbCredentials = new secretsmanager.Secret(this, "DbCredentials", {
      secretName: `${prefix}/db-credentials`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "hostedsymphony" }),
        generateStringKey: "password",
      },
    });

    const database = new rds.DatabaseInstance(this, "Database", {
      vpc,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      credentials: rds.Credentials.fromSecret(dbCredentials),
      databaseName: "hostedsymphony",
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      securityGroups: [dbSecurityGroup],
      multiAz: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      publiclyAccessible: false,
    });

    const queues = {
      dispatch: new sqs.Queue(this, "DispatchQueue", {
        queueName: `${prefix}-dispatch`,
        visibilityTimeout: Duration.minutes(15),
      }),
      refresh: new sqs.Queue(this, "RefreshQueue", {
        queueName: `${prefix}-refresh`,
        visibilityTimeout: Duration.minutes(5),
      }),
      cancel: new sqs.Queue(this, "CancelQueue", {
        queueName: `${prefix}-cancel`,
        visibilityTimeout: Duration.minutes(5),
      }),
      workerEvent: new sqs.Queue(this, "WorkerEventQueue", {
        queueName: `${prefix}-worker-event`,
        visibilityTimeout: Duration.minutes(5),
      }),
    };

    const serviceTokenSecret = new secretsmanager.Secret(this, "ServiceToken", {
      secretName: `${prefix}/service-token`,
      generateSecretString: {
        passwordLength: 48,
      },
    });
    const workerEventSecret = new secretsmanager.Secret(this, "WorkerEventSecret", {
      secretName: `${prefix}/worker-event-secret`,
      generateSecretString: {
        passwordLength: 48,
      },
    });
    const githubAppPrivateKey = new secretsmanager.Secret(this, "GitHubAppPrivateKey", {
      secretName: `${prefix}/github-app-private-key`,
    });
    const openAiApiKey = new secretsmanager.Secret(this, "OpenAiApiKey", {
      secretName: `${prefix}/openai-api-key`,
    });

    const controlPlaneRepository = new ecr.Repository(this, "ControlPlaneRepository", {
      repositoryName: `${prefix}/control-plane`,
      imageScanOnPush: true,
    });
    const workerRepository = new ecr.Repository(this, "WorkerRepository", {
      repositoryName: `${prefix}/worker`,
      imageScanOnPush: true,
    });

    const logGroup = new logs.LogGroup(this, "ControlPlaneLogGroup", {
      logGroupName: `/ecs/${prefix}/control-plane`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const workerLogGroup = new logs.LogGroup(this, "WorkerLogGroup", {
      logGroupName: `/ecs/${prefix}/worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const controlPlaneTask = new ecs.FargateTaskDefinition(this, "ControlPlaneTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      volumes: [
        {
          name: "workspaces",
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: "ENABLED",
          },
        },
      ],
    });

    controlPlaneTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:*", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:CreateSecret"],
        resources: ["*"],
      }),
    );
    workerTask.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"],
      }),
    );

    const mountPoint: ecs.MountPoint = {
      sourceVolume: "workspaces",
      containerPath: "/mnt/symphony",
      readOnly: false,
    };

    const controlPlaneUrl = props.domainName
      ? `https://${props.environmentName}.${props.domainName}`
      : `https://${prefix}.internal`;

    controlPlaneTask.addContainer("ControlPlaneContainer", {
      image: ecs.ContainerImage.fromEcrRepository(controlPlaneRepository, props.imageTag),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "control-plane",
      }),
      portMappings: [{ containerPort: 4310 }],
      secrets: {
        HOSTED_SYMPHONY_SERVICE_TOKEN: ecs.Secret.fromSecretsManager(serviceTokenSecret),
        SYMPHONY_WORKER_EVENT_SECRET: ecs.Secret.fromSecretsManager(workerEventSecret),
      },
      environment: {
        HOSTED_SYMPHONY_MODE: "aws",
        HOSTED_SYMPHONY_ENVIRONMENT: props.environmentName,
        HOSTED_SYMPHONY_BASE_URL: controlPlaneUrl,
        DATABASE_URL: `postgresql://hostedsymphony:${dbCredentials.secretValueFromJson("password").unsafeUnwrap()}@${database.instanceEndpoint.hostname}:5432/hostedsymphony`,
        AWS_REGION: Stack.of(this).region,
        SYMPHONY_QUEUE_URL_DISPATCH: queues.dispatch.queueUrl,
        SYMPHONY_QUEUE_URL_REFRESH: queues.refresh.queueUrl,
        SYMPHONY_QUEUE_URL_CANCEL: queues.cancel.queueUrl,
        SYMPHONY_QUEUE_URL_WORKER_EVENT: queues.workerEvent.queueUrl,
        SYMPHONY_SECRET_PREFIX: `/${prefix}`,
        SYMPHONY_ECS_CLUSTER_ARN: cluster.clusterArn,
        SYMPHONY_ECS_WORKER_TASK_DEFINITION_ARN: workerTask.taskDefinitionArn,
        SYMPHONY_ECS_WORKER_CONTAINER_NAME: "WorkerContainer",
        SYMPHONY_ECS_SUBNET_IDS: vpc.privateSubnets.map((subnet) => subnet.subnetId).join(","),
        SYMPHONY_ECS_SECURITY_GROUP_IDS: appSecurityGroup.securityGroupId,
      },
    });

    const workerContainer = workerTask.addContainer("WorkerContainer", {
      image: ecs.ContainerImage.fromEcrRepository(workerRepository, props.imageTag),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: workerLogGroup,
        streamPrefix: "worker",
      }),
      command: ["node", "dist/cli.js"],
      secrets: {
        GITHUB_APP_PRIVATE_KEY: ecs.Secret.fromSecretsManager(githubAppPrivateKey),
        OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openAiApiKey),
        SYMPHONY_WORKER_EVENT_SECRET: ecs.Secret.fromSecretsManager(workerEventSecret),
      },
      environment: {
        GITHUB_APP_ID: "set-me",
        SYMPHONY_CONTROL_PLANE_URL: controlPlaneUrl,
        SYMPHONY_WORKSPACE_ROOT: "/mnt/symphony",
      },
    });
    workerContainer.addMountPoints(mountPoint);

    const service = new ecs.FargateService(this, "ControlPlaneService", {
      cluster,
      taskDefinition: controlPlaneTask,
      desiredCount: props.environmentName === "prod" ? 2 : 1,
      securityGroups: [appSecurityGroup],
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
      securityGroup: appSecurityGroup,
    });

    const target = service.loadBalancerTarget({
      containerName: "ControlPlaneContainer",
      containerPort: 4310,
    });

    if (props.domainName && props.hostedZoneId && props.hostedZoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
        hostedZoneId: props.hostedZoneId,
        zoneName: props.hostedZoneName,
      });
      const certificate = new acm.Certificate(this, "Certificate", {
        domainName: `${props.environmentName}.${props.domainName}`,
        validation: acm.CertificateValidation.fromDns(zone),
      });
      const listener = alb.addListener("HttpsListener", {
        port: 443,
        certificates: [certificate],
      });
      listener.addTargets("ControlPlaneTargets", {
        port: 4310,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [target],
        healthCheck: {
          path: "/readyz",
        },
      });
      new route53.ARecord(this, "AliasRecord", {
        zone,
        recordName: props.environmentName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
      });
    } else {
      const listener = alb.addListener("HttpListener", { port: 80 });
      listener.addTargets("ControlPlaneTargets", {
        port: 4310,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [target],
        healthCheck: {
          path: "/readyz",
        },
      });
    }

    new cdk.CfnOutput(this, "ControlPlaneRepositoryUri", {
      value: controlPlaneRepository.repositoryUri,
    });
    new cdk.CfnOutput(this, "WorkerRepositoryUri", {
      value: workerRepository.repositoryUri,
    });
    new cdk.CfnOutput(this, "ControlPlaneUrl", {
      value: controlPlaneUrl,
    });
    new cdk.CfnOutput(this, "ServiceTokenSecretArn", {
      value: serviceTokenSecret.secretArn,
    });
  }
}
