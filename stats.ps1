$mLines = Get-Content "C:\Users\openc\.openclaw\workspace\polymarket-arb\data\momentum-trades.jsonl"
$mAll = $mLines | ForEach-Object { $_ | ConvertFrom-Json }
$mClosed = $mAll | Where-Object { $_.action -eq 'CLOSE' }
$mWins = ($mClosed | Where-Object { $_.won -eq $true }).Count
$mLosses = ($mClosed | Where-Object { $_.won -eq $false }).Count
$mTotal = $mClosed.Count
$mOpen = ($mAll | Where-Object { $_.action -eq 'OPEN' }).Count
$mLast10 = $mClosed | Select-Object -Last 10
$mL10w = ($mLast10 | Where-Object { $_.won -eq $true }).Count
$mLast20 = $mClosed | Select-Object -Last 20
$mL20w = ($mLast20 | Where-Object { $_.won -eq $true }).Count
$mLastTrade = $mClosed | Select-Object -Last 1
$mBal = $mLastTrade.balanceAfter
$mWR = $mLastTrade.winrate
Write-Output "MOMENTUM closed=$mTotal wins=$mWins losses=$mLosses open=$mOpen last10w=$mL10w last20w=$mL20w bal=$mBal wr=$mWR"

$sLines = Get-Content "C:\Users\openc\.openclaw\workspace\polymarket-arb\data\snipe-trades.jsonl"
$sAll = $sLines | ForEach-Object { $_ | ConvertFrom-Json }
$sClosed = $sAll | Where-Object { $_.action -eq 'CLOSE' }
$sWins = ($sClosed | Where-Object { $_.won -eq $true }).Count
$sLosses = ($sClosed | Where-Object { $_.won -eq $false }).Count
$sTotal = $sClosed.Count
$sOpen = ($sAll | Where-Object { $_.action -eq 'OPEN' }).Count
$sLastTrade = $sClosed | Select-Object -Last 1
$sBal = $sLastTrade.balanceAfter
$sWR = $sLastTrade.winrate
Write-Output "SNIPE closed=$sTotal wins=$sWins losses=$sLosses open=$sOpen bal=$sBal wr=$sWR"
