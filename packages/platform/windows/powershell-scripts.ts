/**
 * Phase 9 - PowerShell source for the Windows UI Automation port.
 *
 * These are plain, readable scripts. They are deliberately NOT obfuscated or
 * encoded, and they never relax a machine security control (no
 * `-ExecutionPolicy` override, no hidden-window flag, no privilege flags).
 *
 * The scripts talk to `UIAutomationClient`, the accessibility API that ships
 * with Windows. That is the OS-supported, documented mechanism for reading and
 * driving foreground UI - not an app-specific back door, not a private IPC
 * shortcut and not synthetic input injection.
 *
 * Transport is stdin: the adapter pipes the script to `powershell -Command -`,
 * so no script file is ever written to disk and no quoting layer sits between
 * TypeScript and PowerShell.
 *
 * Every script answers with a single JSON line so the port never has to guess:
 *   { "ok": true,  "data": ... }
 *   { "ok": false, "code": "<failure code>", "message": "..." }
 */

/** Failure codes a script may report back without translation. */
export type UiAutomationFailureCode =
  | 'unsupported'
  | 'permission_denied'
  | 'target_not_found'
  | 'actuation_failed'
  | 'observation_failed';

const PREAMBLE = `$ErrorActionPreference = 'Stop'
# Both assemblies are required: the client provides AutomationElement, the types
# assembly provides TreeScope / ControlType. Loading only one leaves the enum
# literals undefined and every lookup silently empty.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$COND = [System.Windows.Automation.Condition]::TrueCondition
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Fail($code, $message) {
  ConvertTo-Json -Compress -InputObject @{ ok = $false; code = $code; message = $message }
  exit 0
}

function Resolve-FocusedWindow {
  $start = $AE::FocusedElement
  if ($start -ne $null) {
    $win = $start
    $guard = 0
    while ($win -ne $null -and $guard -lt 32) {
      try { if ($win.Current.ControlType -eq $CT::Window) { return $win } } catch { break }
      $win = $walker.GetParent($win)
      $guard = $guard + 1
    }
  }
  # Some surfaces (consoles, tool windows) do not expose an inspectable focused
  # window. Fall back to the top-level windows of the accessibility tree, which
  # is the same surface a screen reader walks. This is ordinary accessibility
  # discovery, not a private or hidden channel.
  try {
    $tops = $AE::RootElement.FindAll($TS::Children, $COND)
    for ($i = 0; $i -lt $tops.Count; $i++) {
      $candidate = $tops[$i]
      if ($candidate -eq $null) { continue }
      try {
        if ([string]::IsNullOrEmpty($candidate.Current.Name)) { continue }
        return $candidate
      } catch { continue }
    }
  } catch { }
  return $null
}
`;


/**
 * Observation script: reads the focused window and returns a bounded description
 * of its controls.
 *
 * `maxElements` is a validated integer injected by the caller, never raw text.
 */
export const observeScript = (maxElements: number): string => `${PREAMBLE}
try { Add-Type -AssemblyName UIAutomationClient } catch { Fail 'unsupported' 'UI Automation is not available on this host' }

$maxElements = ${maxElements}

$win = Resolve-FocusedWindow
if ($win -eq $null) { Fail 'observation_failed' 'No accessible foreground window' }

$processName = 'unknown'
try { $processName = [System.Diagnostics.Process]::GetProcessById($win.Current.ProcessId).ProcessName } catch { $processName = 'unknown' }
$windowTitle = ''
try { $windowTitle = [string]$win.Current.Name } catch { $windowTitle = '' }

$found = $win.FindAll($TS::Descendants, $COND)
$count = $found.Count
if ($count -gt $maxElements) { $count = $maxElements }

$elements = @()
for ($i = 0; $i -lt $count; $i++) {
  $el = $found[$i]
  if ($el -eq $null) { continue }
  try {
    $c = $el.Current
    $bounds = $null
    try {
      $r = $c.BoundingRectangle
      if ($r.Width -gt 0 -and $r.Height -gt 0) {
        $bounds = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
      }
    } catch { $bounds = $null }

    $invokable = $false
    try { $invokable = ($null -ne $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)) } catch { $invokable = $false }
    $hasValue = $false
    try { $hasValue = ($null -ne $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)) } catch { $hasValue = $false }

    $value = ''
    try { if ($hasValue -and -not $c.IsPassword) { $value = [string]$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } } catch { $value = '' }

    $entry = @{
      ref = $(if ([string]::IsNullOrEmpty($c.AutomationId)) { [string]$c.ControlType.ProgrammaticName + '|' + [string]$c.Name } else { [string]$c.AutomationId })
      name = [string]$c.Name
      controlType = [string]$c.ControlType.ProgrammaticName
      enabled = [bool]$c.IsEnabled
      offscreen = [bool]$c.IsOffscreen
      focused = [bool]$c.HasKeyboardFocus
      password = [bool]$c.IsPassword
      invokable = $invokable
      hasValue = $hasValue
      value = $value
    }
    if (-not [string]::IsNullOrEmpty($c.AutomationId)) { $entry['automationId'] = [string]$c.AutomationId }
    if ($bounds -ne $null) { $entry['bounds'] = $bounds }
    $elements += $entry
  } catch {
    # One unreadable node (protected/system surface) must not fail the whole
    # observation; the remaining tree is still useful.
  }
}

ConvertTo-Json -Compress -Depth 6 -InputObject @{ ok = $true; data = @{ processName = $processName; windowTitle = $windowTitle; elements = $elements } }
`;

/**
 * Actuation script: performs exactly ONE low-risk UI Automation operation
 * against a grounded element in the focused window.
 *
 * The request is embedded as a JSON literal inside a PowerShell here-string, so
 * it is parsed as data and can never be spliced into code.
 *
 * Only three operations exist: invoke a control, set a text value, move focus.
 * There is deliberately no mouse or key synthesis path here at all.
 */
export const invokeScript = (requestJson: string): string => `${PREAMBLE}
try { Add-Type -AssemblyName UIAutomationClient } catch { Fail 'unsupported' 'UI Automation is not available on this host' }

$payloadJson = @'
${requestJson}
'@
$payload = $payloadJson | ConvertFrom-Json

$win = Resolve-FocusedWindow
if ($win -eq $null) { Fail 'observation_failed' 'No accessible foreground window' }

$found = $win.FindAll($TS::Descendants, $COND)
$matches = @()
for ($i = 0; $i -lt $found.Count; $i++) {
  $el = $found[$i]
  if ($el -eq $null) { continue }
  try {
    $c = $el.Current
    $idMatch = $true
    if ($payload.locator.PSObject.Properties.Name -contains 'automationId') {
      $idMatch = ([string]$c.AutomationId -eq [string]$payload.locator.automationId)
    }
    $nameMatch = $true
    if ($payload.locator.PSObject.Properties.Name -contains 'name') {
      $nameMatch = ([string]$c.Name -eq [string]$payload.locator.name)
    }
    $typeMatch = $true
    if ($payload.locator.PSObject.Properties.Name -contains 'controlType') {
      $typeMatch = ([string]$c.ControlType.ProgrammaticName -eq [string]$payload.locator.controlType)
    }
    if ($idMatch -and $nameMatch -and $typeMatch) { $matches += $el }
  } catch { }
}

if ($matches.Count -eq 0) { Fail 'target_not_found' 'Grounded element is not present in the foreground window' }
if ($matches.Count -gt 1) { Fail 'target_not_found' 'Grounded element is no longer uniquely identifiable' }
$el = $matches[0]

$operation = [string]$payload.operation
if ($operation -eq 'click') {
  $pattern = $null
  try { $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) } catch { $pattern = $null }
  if ($pattern -eq $null) { Fail 'unsupported' 'Control does not support the UI Automation invoke pattern' }
  try { $pattern.Invoke() } catch { Fail 'permission_denied' 'The host refused to invoke this control' }
} elseif ($operation -eq 'type') {
  try {
    if ($el.Current.IsPassword) { Fail 'permission_denied' 'Refusing to enter text into a password field' }
  } catch { Fail 'actuation_failed' 'Control state could not be read' }
  $pattern = $null
  try { $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch { $pattern = $null }
  if ($pattern -eq $null) { Fail 'unsupported' 'Control does not support the UI Automation value pattern' }
  try { $pattern.SetValue([string]$payload.text) } catch { Fail 'actuation_failed' 'The host refused the value assignment' }
} elseif ($operation -eq 'focus') {
  try { $el.SetFocus() } catch { Fail 'actuation_failed' 'The host refused to move focus' }
} else {
  Fail 'unsupported' 'Unknown operation'
}

ConvertTo-Json -Compress -InputObject @{ ok = $true; data = @{ acted = $true } }
`;

