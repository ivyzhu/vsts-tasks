[CmdletBinding()]
param()

Trace-VstsEnteringInvocation $MyInvocation

# Get inputs for the task
$connectedServiceNameSelector = Get-VstsInput -Name ConnectedServiceNameSelector -Require
$sourcePath = Get-VstsInput -Name SourcePath -Require
$destination = Get-VstsInput -Name Destination -Require
$connectedServiceName = Get-VstsInput -Name ConnectedServiceName
$connectedServiceNameARM = Get-VstsInput -Name ConnectedServiceNameARM
$storageAccount = Get-VstsInput -Name StorageAccount
$storageAccountRM = Get-VstsInput -Name StorageAccountRM
$containerName = Get-VstsInput -Name ContainerName
$blobPrefix = Get-VstsInput -Name BlobPrefix
$environmentName = Get-VstsInput -Name EnvironmentName
$environmentNameRM = Get-VstsInput -Name EnvironmentNameRM
$resourceFilteringMethod = Get-VstsInput -Name ResourceFilteringMethod
$machineNames = Get-VstsInput -Name MachineNames
$vmsAdminUserName = Get-VstsInput -Name VmsAdminUsername
$vmsAdminPassword = Get-VstsInput -Name VmsAdminPassword
$targetPath = Get-VstsInput -Name TargetPath
$additionalArguments = Get-VstsInput -Name AdditionalArguments
$cleanTargetBeforeCopy = Get-VstsInput -Name CleanTargetBeforeCopy -AsBool
$copyFilesInParallel = Get-VstsInput -Name CopyFilesInParallel -AsBool
$skipCACheck = Get-VstsInput -Name SkipCACheck -AsBool
$enableCopyPrerequisites = Get-VstsInput -Name EnableCopyPrerequisites -AsBool
$outputStorageContainerSasToken = Get-VstsInput -Name OutputStorageContainerSasToken
$outputStorageURI = Get-VstsInput -Name OutputStorageUri

if ($connectedServiceNameSelector -eq "ConnectedServiceNameARM")
{
    $connectedServiceName = $connectedServiceNameARM
    $storageAccount = $storageAccountRM
    $environmentName = $environmentNameRM
}

# Constants
$defaultSasTokenTimeOutInHours = 4
$useHttpsProtocolOption = ''
$ErrorActionPreference = 'Stop'
$telemetrySet = $false

$sourcePath = $sourcePath.Trim('"')
$storageAccount = $storageAccount.Trim()

# azcopy location on automation agent
$azCopyExeLocation = 'AzCopy\AzCopy.exe'
$azCopyLocation = [System.IO.Path]::GetDirectoryName($azCopyExeLocation)

# Initialize Azure.
Import-Module $PSScriptRoot\ps_modules\VstsAzureHelpers_
Initialize-Azure

# Import the loc strings.
Import-VstsLocStrings -LiteralPath $PSScriptRoot/Task.json

# Import all the dlls and modules which have cmdlets we need
Import-Module "$PSScriptRoot\DeploymentUtilities\Microsoft.TeamFoundation.DistributedTask.Task.Deployment.Internal.psm1"
Import-Module "$PSScriptRoot\DeploymentUtilities\Microsoft.TeamFoundation.DistributedTask.Task.Deployment.dll"

# Load all dependent files for execution
. "$PSScriptRoot\AzureFileCopyJob.ps1"
. "$PSScriptRoot\Utility.ps1"

# Enabling detailed logging only when system.debug is true
$enableDetailedLoggingString = $env:system_debug
if ($enableDetailedLoggingString -ne "true")
{
    $enableDetailedLoggingString = "false"
}

#### MAIN EXECUTION OF AZURE FILE COPY TASK BEGINS HERE ####
try
{
    # Importing required version of azure cmdlets according to azureps installed on machine
    $azureUtility = Get-AzureUtility

    Write-Verbose -Verbose "Loading $azureUtility"
    . "$PSScriptRoot/$azureUtility"

    # Getting connection type (Certificate/UserNamePassword/SPN) used for the task
    $connectionType = Get-ConnectionType -connectedServiceName $connectedServiceName

    # Getting storage key for the storage account based on the connection type
    $storageKey = Get-StorageKey -storageAccountName $storageAccount -connectionType $connectionType

    # creating storage context to be used while creating container, sas token, deleting container
    $storageContext = Create-AzureStorageContext -StorageAccountName $storageAccount -StorageAccountKey $storageKey

    # creating temporary container for uploading files if no input is provided for container name
    if([string]::IsNullOrEmpty($containerName))
    {
        $containerName = [guid]::NewGuid().ToString()
        Create-AzureContainer -containerName $containerName -storageContext $storageContext
    }
	
    # Geting Azure Blob Storage Endpoint
    $blobStorageEndpoint = Get-blobStorageEndpoint -storageAccountName $storageAccount -connectionType $connectionType
}
catch
{
    if(-not $telemetrySet)
    {
        Write-TaskSpecificTelemetry "UNKNOWNPREDEP_Error"
    }

    throw
}

# Uploading files to container
Upload-FilesToAzureContainer -sourcePath $sourcePath -storageAccountName $storageAccount -containerName $containerName -blobPrefix $blobPrefix -blobStorageEndpoint $blobStorageEndpoint -storageKey $storageKey `
                             -azCopyLocation $azCopyLocation -additionalArguments $additionalArguments -destinationType $destination

# Complete the task if destination is azure blob
if ($destination -eq "AzureBlob")
{
    # Get URI and SaSToken for output if needed
    if(-not [string]::IsNullOrEmpty($outputStorageURI))
    {
        $storageAccountContainerURI = $storageContext.BlobEndPoint + $containerName
        Write-Host "##vso[task.setvariable variable=$outputStorageURI;]$storageAccountContainerURI"
    }
    if(-not [string]::IsNullOrEmpty($outputStorageContainerSASToken))
    {
        $storageContainerSaSToken = New-AzureStorageContainerSASToken -Container $containerName -Context $storageContext -Permission r -ExpiryTime (Get-Date).AddHours($defaultSasTokenTimeOutInHours)
        Write-Host "##vso[task.setvariable variable=$outputStorageContainerSASToken;]$storageContainerSasToken"
    }
    Write-Verbose "Completed Azure File Copy Task for Azure Blob Destination"
    return
}

# Copying files to Azure VMs
try
{
    # getting azure vms properties(name, fqdn, winrmhttps port)
    $azureVMResourcesProperties = Get-AzureVMResourcesProperties -resourceGroupName $environmentName -connectionType $connectionType `
    -resourceFilteringMethod $resourceFilteringMethod -machineNames $machineNames -enableCopyPrerequisites $enableCopyPrerequisites

    $skipCACheckOption = Get-SkipCACheckOption -skipCACheck $skipCACheck
    $azureVMsCredentials = Get-AzureVMsCredentials -vmsAdminUserName $vmsAdminUserName -vmsAdminPassword $vmsAdminPassword

    # generate container sas token with full permissions
    $containerSasToken = Generate-AzureStorageContainerSASToken -containerName $containerName -storageContext $storageContext -tokenTimeOutInHours $defaultSasTokenTimeOutInHours

    #copies files on azureVMs 
    Copy-FilesToAzureVMsFromStorageContainer `
        -storageAccountName $storageAccount -containerName $containerName -containerSasToken $containerSasToken -blobStorageEndpoint $blobStorageEndpoint -targetPath $targetPath -azCopyLocation $azCopyLocation `
        -resourceGroupName $environmentName -azureVMResourcesProperties $azureVMResourcesProperties -azureVMsCredentials $azureVMsCredentials `
        -cleanTargetBeforeCopy $cleanTargetBeforeCopy -communicationProtocol $useHttpsProtocolOption -skipCACheckOption $skipCACheckOption `
        -enableDetailedLoggingString $enableDetailedLoggingString -additionalArguments $additionalArguments -copyFilesInParallel $copyFilesInParallel -connectionType $connectionType
}
catch
{
    Write-Verbose $_.Exception.ToString() -Verbose

    Write-TaskSpecificTelemetry "UNKNOWNDEP_Error"
    throw
}
finally
{
    Remove-AzureContainer -containerName $containerName -storageContext $storageContext
    Write-Verbose "Completed Azure File Copy Task for Azure VMs Destination" -Verbose
    Trace-VstsLeavingInvocation $MyInvocation
}
