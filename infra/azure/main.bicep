targetScope = 'resourceGroup'

@allowed([
  'staging'
  'prod'
])
param environment string

param location string = resourceGroup().location
param postgresLocation string = location
param namePrefix string = 'hosted-symphony-${environment}'

@description('Existing or new Azure Container Registry name. Must be globally unique.')
param containerRegistryName string

@description('Storage account name for queue + Azure Files. Must be globally unique and lowercase.')
param storageAccountName string

@description('Key Vault name for Hosted Symphony runtime and per-repo Linear secrets.')
param keyVaultName string

@description('Flexible Server name for Hosted Symphony state.')
param postgresServerName string

@description('Postgres administrator login.')
param postgresAdminLogin string

@secure()
@description('Postgres administrator password.')
param postgresAdminPassword string

@description('Published control-plane URL used by the extension and worker callbacks.')
param controlPlaneBaseUrl string

@description('Container image for the Hosted Symphony control plane.')
param controlPlaneImage string

@description('Container image for the Hosted Symphony worker.')
param workerImage string

@secure()
param serviceToken string

@secure()
param workerEventSecret string

@secure()
param githubAppId string

@secure()
param githubAppPrivateKey string

@secure()
param openAiApiKey string

param controlPlanePort int = 4310
param controlPlaneCpu int = 1
param controlPlaneMemory string = '2Gi'
param workerCpu int = 1
param workerMemory string = '2Gi'
param workerReplicaTimeoutSeconds int = 3600
param workspaceShareName string = 'symphony-workspaces'
param postgresDatabaseName string = 'hostedsymphony'
param postgresSkuName string = 'Standard_B1ms'
param postgresStorageSizeGb int = 32
param postgresVersion string = '16'

var controlPlaneAppName = '${namePrefix}-cp'
var workerJobName = '${namePrefix}-worker'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: containerRegistryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource workspaceShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: workspaceShareName
  properties: {
    enabledProtocols: 'SMB'
    accessTier: 'TransactionOptimized'
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource dispatchQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: '${namePrefix}-dispatch'
}

resource refreshQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: '${namePrefix}-refresh'
}

resource cancelQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: '${namePrefix}-cancel'
}

resource workerEventQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: '${namePrefix}-worker-event'
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = {
  name: postgresServerName
  location: postgresLocation
  sku: {
    name: postgresSkuName
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: postgresVersion
    storage: {
      storageSizeGB: postgresStorageSizeGb
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
  }
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = {
  parent: postgres
  name: postgresDatabaseName
}

resource postgresFirewallAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2022-12-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: false
    enabledForTemplateDeployment: true
    sku: {
      family: 'A'
      name: 'standard'
    }
    accessPolicies: []
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: listKeys(logAnalytics.id, logAnalytics.apiVersion).primarySharedKey
      }
    }
  }
}

resource managedEnvironmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: managedEnvironment
  name: 'workspace-share'
  properties: {
    azureFile: {
      accessMode: 'ReadWrite'
      accountName: storage.name
      accountKey: listKeys(storage.id, storage.apiVersion).keys[0].value
      shareName: workspaceShare.name
    }
  }
}

var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${listKeys(storage.id, storage.apiVersion).keys[0].value};EndpointSuffix=core.windows.net'
var databaseUrl = 'postgresql://${postgresAdminLogin}:${postgresAdminPassword}@${postgresServerName}.postgres.database.azure.com:5432/${postgresDatabaseName}?sslmode=require'
var acrLoginServer = '${acr.name}.azurecr.io'
var queueNames = {
  dispatch: dispatchQueue.name
  refresh: refreshQueue.name
  cancel: cancelQueue.name
  workerEvent: workerEventQueue.name
}

resource controlPlane 'Microsoft.App/containerApps@2024-03-01' = {
  name: controlPlaneAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: controlPlanePort
        transport: 'http'
      }
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
        {
          name: 'service-token'
          value: serviceToken
        }
        {
          name: 'worker-event-secret'
          value: workerEventSecret
        }
        {
          name: 'storage-connection-string'
          value: storageConnectionString
        }
        {
          name: 'github-app-id'
          value: githubAppId
        }
        {
          name: 'github-app-private-key'
          value: githubAppPrivateKey
        }
        {
          name: 'openai-api-key'
          value: openAiApiKey
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'control-plane'
          image: controlPlaneImage
          resources: {
            cpu: controlPlaneCpu
            memory: controlPlaneMemory
          }
          env: [
            {
              name: 'PORT'
              value: string(controlPlanePort)
            }
            {
              name: 'HOSTED_SYMPHONY_CLOUD_PROVIDER'
              value: 'azure'
            }
            {
              name: 'HOSTED_SYMPHONY_ENVIRONMENT'
              value: environment
            }
            {
              name: 'HOSTED_SYMPHONY_BASE_URL'
              value: controlPlaneBaseUrl
            }
            {
              name: 'DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'HOSTED_SYMPHONY_SERVICE_TOKEN'
              secretRef: 'service-token'
            }
            {
              name: 'SYMPHONY_WORKER_EVENT_SECRET'
              secretRef: 'worker-event-secret'
            }
            {
              name: 'AZURE_STORAGE_CONNECTION_STRING'
              secretRef: 'storage-connection-string'
            }
            {
              name: 'AZURE_KEY_VAULT_URL'
              value: keyVault.properties.vaultUri
            }
            {
              name: 'AZURE_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'AZURE_CONTAINERAPPS_JOB_NAME'
              value: workerJobName
            }
            {
              name: 'AZURE_CONTAINERAPPS_JOB_CONTAINER_NAME'
              value: 'worker'
            }
            {
              name: 'AZURE_CONTAINERAPPS_WORKER_IMAGE'
              value: workerImage
            }
            {
              name: 'AZURE_CONTAINERAPPS_WORKER_CPU'
              value: string(workerCpu)
            }
            {
              name: 'AZURE_CONTAINERAPPS_WORKER_MEMORY'
              value: workerMemory
            }
            {
              name: 'AZURE_CONTAINERAPPS_LOG_NAMESPACE'
              value: '${resourceGroup().name}/${namePrefix}-worker'
            }
            {
              name: 'AZURE_QUEUE_NAME_DISPATCH'
              value: queueNames.dispatch
            }
            {
              name: 'AZURE_QUEUE_NAME_REFRESH'
              value: queueNames.refresh
            }
            {
              name: 'AZURE_QUEUE_NAME_CANCEL'
              value: queueNames.cancel
            }
            {
              name: 'AZURE_QUEUE_NAME_WORKER_EVENT'
              value: queueNames.workerEvent
            }
            {
              name: 'GITHUB_APP_ID'
              secretRef: 'github-app-id'
            }
            {
              name: 'GITHUB_APP_PRIVATE_KEY'
              secretRef: 'github-app-private-key'
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
          ]
        }
      ]
    }
  }
}

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: workerJobName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: workerReplicaTimeoutSeconds
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: 'worker-event-secret'
          value: workerEventSecret
        }
        {
          name: 'github-app-id'
          value: githubAppId
        }
        {
          name: 'github-app-private-key'
          value: githubAppPrivateKey
        }
        {
          name: 'openai-api-key'
          value: openAiApiKey
        }
      ]
    }
    template: {
      volumes: [
        {
          name: 'workspaces'
          storageType: 'AzureFile'
          storageName: managedEnvironmentStorage.name
        }
      ]
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: {
            cpu: workerCpu
            memory: workerMemory
          }
          env: [
            {
              name: 'HOSTED_SYMPHONY_CLOUD_PROVIDER'
              value: 'azure'
            }
            {
              name: 'HOSTED_SYMPHONY_ENVIRONMENT'
              value: environment
            }
            {
              name: 'SYMPHONY_CONTROL_PLANE_URL'
              value: controlPlaneBaseUrl
            }
            {
              name: 'SYMPHONY_WORKER_EVENT_SECRET'
              secretRef: 'worker-event-secret'
            }
            {
              name: 'SYMPHONY_WORKSPACE_ROOT'
              value: '/mnt/symphony'
            }
            {
              name: 'SYMPHONY_LOG_NAMESPACE'
              value: '${resourceGroup().name}/${workerJobName}'
            }
            {
              name: 'SYMPHONY_AZURE_JOB_NAME'
              value: workerJobName
            }
            {
              name: 'SYMPHONY_AZURE_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'GITHUB_APP_ID'
              secretRef: 'github-app-id'
            }
            {
              name: 'GITHUB_APP_PRIVATE_KEY'
              secretRef: 'github-app-private-key'
            }
            {
              name: 'OPENAI_API_KEY'
              secretRef: 'openai-api-key'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'workspaces'
              mountPath: '/mnt/symphony'
            }
          ]
        }
      ]
    }
  }
}

resource acrPullControlPlane 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, controlPlane.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: controlPlane.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPullWorker 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, workerJob.id, 'AcrPull')
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: workerJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource controlPlaneVaultAccess 'Microsoft.KeyVault/vaults/accessPolicies@2023-07-01' = {
  parent: keyVault
  name: 'add'
  properties: {
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: controlPlane.identity.principalId
        permissions: {
          secrets: [
            'Get'
            'List'
            'Set'
            'Delete'
          ]
        }
      }
    ]
  }
}

resource serviceTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'hosted-symphony-service-token'
  properties: {
    value: serviceToken
  }
}

resource workerEventSecretSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'hosted-symphony-worker-event-secret'
  properties: {
    value: workerEventSecret
  }
}

resource githubAppIdSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'hosted-symphony-github-app-id'
  properties: {
    value: githubAppId
  }
}

resource githubAppPrivateKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'hosted-symphony-github-app-private-key'
  properties: {
    value: githubAppPrivateKey
  }
}

resource openAiApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'hosted-symphony-openai-api-key'
  properties: {
    value: openAiApiKey
  }
}

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'hosted-symphony-database-url'
  properties: {
    value: databaseUrl
  }
}

output controlPlaneContainerAppName string = controlPlane.name
output controlPlaneIngressFqdn string = controlPlane.properties.configuration.ingress.fqdn
output controlPlanePublicUrl string = controlPlaneBaseUrl
output workerJobName string = workerJob.name
output keyVaultUri string = keyVault.properties.vaultUri
output containerRegistryLoginServer string = acrLoginServer
output storageConnectionString string = storageConnectionString
output postgresHost string = '${postgres.name}.postgres.database.azure.com'
output postgresDatabase string = postgresDatabase.name
output queueNames object = queueNames
