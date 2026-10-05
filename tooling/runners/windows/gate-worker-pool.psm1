Set-StrictMode -Version Latest

function Get-GateWorkerPlan {
    param([ValidateRange(0,5)][int]$Slot, [string]$Root = 'C:\kalcode-ci-pool')
    $offset = $Slot * 20
    [pscustomobject]@{
        Slot = $Slot
        Name = $(if ($Slot -eq 0) { 'kalcode-win-gate' } else { "kalcode-win-gate-w$Slot" })
        Account = $(if ($Slot -eq 0) { 'kalcode-ci' } else { "kalcode-ci-w$Slot" })
        Root = $(if ($Slot -eq 0) { 'C:\kalcode-ci' } else { Join-Path $Root "worker-w$Slot" })
        Labels = 'kalcode-gate,kalcode-main-pc'
        RegistrationLabels = 'kalcode-gate-pool-staging,kalcode-main-pc'
        E2ePort = 4491 + $offset
        MailPort = 4492 + $offset
        InspectorPort = 9501 + $offset
        UiPort = 1591 + $offset
        CdpPort = 19333 + $Slot * 1000
    }
}

function Test-GateWorkerAdmission {
    param($Sample, [int]$Active = 0)
    # The original slot0 participates through future workflows; its current job stays untouched.
    # Native checks additionally need one of the workflow's three machine-wide heavy leases.
    if ($Active -ge 6) { return 'worker_slots_busy' }
    if ($null -eq $Sample -or $null -eq $Sample.Cpu -or $null -eq $Sample.FreeGiB -or
        $null -eq $Sample.CommitPercent -or $null -eq $Sample.DiskQueue) { return 'resource_data_unavailable' }
    foreach ($value in @($Sample.Cpu,$Sample.FreeGiB,$Sample.CommitPercent,$Sample.DiskQueue)) {
        if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return 'resource_data_invalid' }
    }
    if ($Sample.Cpu -lt 0 -or $Sample.Cpu -gt 100 -or
        $Sample.FreeGiB -lt 0 -or $Sample.CommitPercent -lt 0 -or $Sample.CommitPercent -gt 100 -or
        $Sample.DiskQueue -lt 0) { return 'resource_data_invalid' }
    if ($Sample.FreeGiB -lt (16 + 2 * $Active) -or $Sample.CommitPercent -ge 85) { return 'memory_pressure' }
    if ($Sample.Cpu -ge 85) { return 'cpu_pressure' }
    if ($Sample.DiskQueue -ge 8) { return 'disk_pressure' }
    return 'allowed'
}

function Get-GateWorkerResources {
    $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
    $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop
    $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter "Name='_Total'" -ErrorAction Stop
    if ($null -eq $cpu -or $null -eq $memory -or $null -eq $disk) { return $null }
    [pscustomobject]@{ Cpu = [double]$cpu.PercentProcessorTime; FreeGiB = [double]$memory.AvailableMBytes / 1024
        CommitPercent = [double]$memory.PercentCommittedBytesInUse; DiskQueue = [double]$disk.CurrentDiskQueueLength }
}

function Assert-GateWorkerHost {
    $machine = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    if ($machine.Name -ne 'DESKTOP-KOOB7VV' -or $machine.TotalPhysicalMemory -lt 56GB) {
        throw 'Gate workers belong only on the main 64 GB Windows PC (DESKTOP-KOOB7VV).'
    }
}

Export-ModuleMember -Function Get-GateWorkerPlan, Test-GateWorkerAdmission, Get-GateWorkerResources, Assert-GateWorkerHost
