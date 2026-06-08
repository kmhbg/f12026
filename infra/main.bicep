@description('Azure region for all resources')
param location string = 'swedencentral'

@description('Base name prefix for resources')
param baseName string = 'f12026test'

var logAnalyticsName = '${baseName}-logs'
var environmentName = '${baseName}-env'
var appName = 'f12026-test'
var storageAccountName = toLower(replace('${baseName}cache', '-', ''))
var cacheShareName = 'f12026-cache'
var cacheStorageMountName = 'sessioncache'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource cacheFileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: storageAccount::fileServices
  name: cacheShareName
  properties: {
    shareQuota: 10
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource cacheEnvironmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: containerAppsEnvironment
  name: cacheStorageMountName
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: cacheShareName
      accessMode: 'ReadWrite'
    }
  }
}

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: appName
          image: containerImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'CACHE_DIR'
              value: '/app/data/cache'
            }
            {
              name: 'CACHE_SYNC_INTERVAL_MS'
              value: '21600000'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'cache-volume'
              mountPath: '/app/data/cache'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'cache-volume'
          storageType: 'AzureFile'
          storageName: cacheStorageMountName
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
      }
    }
  }
}

@description('Container image (public registry, e.g. ghcr.io/owner/repo:tag)')
param containerImage string

output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output containerAppName string = containerApp.name
output environmentName string = containerAppsEnvironment.name
output logAnalyticsWorkspaceId string = logAnalytics.id
output cacheStorageAccountName string = storageAccount.name
output cacheFileShareName string = cacheShareName
