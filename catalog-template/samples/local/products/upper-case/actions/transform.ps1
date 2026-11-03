#!/usr/bin/env pwsh
# upper-case's "transform" action: the text in capitals, using the same
# casing rules in every locale (ToUpperInvariant), so "straße" and "ödön"
# come out the same wherever it runs.
#
# Reads /platform/input/request.json, writes /platform/output/result.json:
# {"status": "succeeded", "outputs": {...}} or
# {"status": "failed", "error": {"code", "message", "retryable"}}.
$ErrorActionPreference = 'Stop'

$InputPath = '/platform/input/request.json'
$OutputPath = '/platform/output/result.json'
# The output carries the text back, and result.json is limited to 4 KB: a
# limit in characters, and the encoded result measured too, since JSON
# writes a control character as six bytes and UTF-8 others as up to four.
$MaxLength = 1000
$MaxResultBytes = 4096

function ConvertTo-Result([hashtable] $Result) {
    $Result | ConvertTo-Json -Compress -Depth 4
}

function Write-Result([hashtable] $Result) {
    ConvertTo-Result $Result | Set-Content -Path $OutputPath -Encoding utf8NoBOM -NoNewline
}

function Exit-Failed([string] $Code, [string] $Message) {
    Write-Result @{ status = 'failed'; error = @{ code = $Code; message = $Message; retryable = $false } }
    exit 1
}

$request = Get-Content -Path $InputPath -Raw | ConvertFrom-Json -AsHashtable
$inputs = if ($request.ContainsKey('inputs') -and $request.inputs -is [hashtable]) { $request.inputs } else { @{} }
$text = $inputs['text']
if ($text -isnot [string] -or [string]::IsNullOrWhiteSpace($text)) {
    Exit-Failed 'MISSING_INPUT' 'inputs.text is required: the text to change.'
}
# Counted in code points, the way the other language samples count.
$length = @($text.EnumerateRunes()).Count
if ($length -gt $MaxLength) {
    Exit-Failed 'TEXT_TOO_LONG' "inputs.text is $length characters; the limit is $MaxLength."
}

$result = @{ status = 'succeeded'; outputs = @{ text = $text.ToUpperInvariant(); language = 'PowerShell' } }
if ([Text.Encoding]::UTF8.GetByteCount((ConvertTo-Result $result)) -gt $MaxResultBytes) {
    Exit-Failed 'TEXT_TOO_LONG' "inputs.text would make a result over $MaxResultBytes bytes."
}

# A JSON line with level info: what everyone who can see the run sees.
# Anything else (debug, warn, error, plain) only this team sees.
Write-Output (@{ level = 'info'; msg = "upper-cased $length characters" } | ConvertTo-Json -Compress)
Write-Result $result
exit 0
