$lines = Get-Content "$PSScriptRoot\data\momentum-trades.jsonl" | ConvertFrom-Json
$closes = $lines | Where-Object { $_.action -eq 'CLOSE' }
$wins = ($closes | Where-Object { $_.won -eq $true }).Count
$losses = ($closes | Where-Object { $_.won -eq $false }).Count
$total = $wins + $losses
$wr = [math]::Round($wins/$total*100,1)

$filt = $closes | Where-Object { [double]$_.entryPrice -ge 0.60 }
$fw = ($filt | Where-Object { $_.won -eq $true }).Count
$fl = ($filt | Where-Object { $_.won -eq $false }).Count
$ft = $fw + $fl
$fwr = [math]::Round($fw/$ft*100,1)

$last = $closes[-1]
$opens = ($lines | Where-Object { $_.action -eq 'OPEN' }).Count
$orphans = $opens - $total

Write-Host "=== Trade Analysis ==="
Write-Host "All trades: ${total} (${wins}W / ${losses}L) = ${wr}%"
Write-Host "Filtered (>=0.60): ${ft} (${fw}W / ${fl}L) = ${fwr}%"
Write-Host "Balance: $($last.balanceAfter)"
Write-Host "Orphaned opens: ${orphans}"
Write-Host "Last trade end: $($last.endDate)"
Write-Host "Last trade winrate field: $($last.winrate)"
