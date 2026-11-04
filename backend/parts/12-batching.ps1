# ------------------------------------------------------------------ batching

function Get-NodeLabel($node) {
    if ($null -eq $node) { return '(unknown element)' }
    $type = ([string]$node.controlType).Replace('ControlType.', '')
    $name = [string]$node.name
    $id = [string]$node.automationId
    $label = "($type)"
    if ($name -ne '') { $label = "$type `"$name`"" }
    if ($id -ne '') { $label = "$label #$id" }
    return $label
}

function Invoke-UiaStep([object]$step) {
    # A UI Automation action writes to the application just as a click does, so a *write* step
    # is refused once the call's budget is spent -- and a read step is not, because a read
    # inside the budget is exactly what sec. 5.7 asks to keep working while it lasts (sec. 5.7, item 4).
    $stepAction = "$($step.action)".ToLowerInvariant()
    if ($WRITE_STEP_ACTIONS -contains $stepAction) { Assert-CanSend "before the '$stepAction' step" }
    # Maps a batch step onto the same code path computer_ui_action uses, so a whole
    # deterministic sequence (click, type, invoke, read the value back) costs one
    # model round trip instead of four.
    $a = @{}
    if ($null -ne $step.ref -and "$($step.ref)" -ne '') { $a.ref = "$($step.ref)" }
    if ($null -ne $step.hwnd) { $a.hwnd = $step.hwnd }
    if ($null -ne $step.automation_id) { $a.automationId = $step.automation_id }
    if ($null -ne $step.name) { $a.name = $step.name }
    if ($null -ne $step.control_type) { $a.controlType = $step.control_type }
    if ($null -ne $step.class_name) { $a.className = $step.class_name }
    if ($null -ne $step.element_index) { $a.index = $step.element_index }
    if ($null -ne $step.value) { $a.value = $step.value }
    if ($null -ne $step.text) { $a.text = $step.text }
    if ($null -ne $step.prefix) { $a.prefix = $step.prefix }
    if ($null -ne $step.suffix) { $a.suffix = $step.suffix }
    if ($null -ne $step.selection_type) { $a.selectionType = $step.selection_type }
    $a.action = "$($step.action)"
    # `ref` is a pre-resolution layer, so a step carrying one takes the ref-aware
    # path and inherits the same stale-ref refusal the single-step tool has.
    if ($null -ne $a.ref) { return Do-UiActByRef $a }
    return Do-UiAct $a
}

# The single-step tool, the batch dispatcher and the host's schema all describe the
# same set of actions, and they have to agree in both directions:
#
#   * an action the schema accepts needs a branch here, otherwise a caller that used
#     only documented parameters gets "unknown step action" -- which is what used to
#     happen to click_text, get_caret, legacy_action, locate_text and the four window
#     actions (29 declared, 21 implemented);
#   * the host refuses to talk to a worker whose list differs from its own, so a
#     half-applied upgrade fails loudly at startup instead of on the model's third
#     action.
#
# Order is part of the contract and is checked, so it is written once, here.
$UIA_STEP_ACTIONS = @(
    'invoke', 'set_value', 'get_value', 'get_text', 'select_text', 'scroll_into_view',
    'toggle', 'select', 'expand', 'collapse',
    'close', 'minimize', 'maximize', 'restore', 'legacy_action',
    'click_text', 'locate_text', 'get_caret'
)
$STEP_ACTIONS = @('click', 'move', 'drag', 'scroll', 'type', 'key', 'wait', 'wait_for', 'screenshot', 'paste', 'focus', 'clipboard') + $UIA_STEP_ACTIONS

function Get-UiaStepLine([string]$action, $receipt) {
    # One line per step, in the shape the host renders. Read-only steps report what
    # they read; window actions report the element they acted on.
    $label = Get-NodeLabel $receipt.matched
    switch ($action) {
        'get_value'        { return "get_value $label -> $($receipt.value)" }
        'get_text'         {
            $shown = "$($receipt.value)"
            if ($shown.Length -gt 2000) { $shown = $shown.Substring(0, 2000) }
            return "get_text $label -> $shown"
        }
        'set_value'        { return "set_value $label = $($receipt.value)" }
        'select_text'      { return "select_text $label -> '$($receipt.value)'" }
        'click_text'       { return "click_text '$($receipt.value)' $label" }
        'locate_text'      { return "locate_text '$($receipt.value)' $label" }
        'get_caret'        { return "get_caret line='$($receipt.value)'" }
        'legacy_action'    { return "legacy_action $label" }
        default            { return "$action $label" }
    }
}

$WRITE_STEP_ACTIONS = @(
    # `move` is in here because it is a write: it changes what is under the cursor (hover,
    # tooltip, focus ring), the batch stamps a write ordinal for it, and $FOREGROUND_STEP_ACTIONS
    # has always listed it. Leaving it out meant a batch whose only write was a move answered
    # `evidence: null` -- a request for evidence silently dropped -- and, worse, let the
    # evidence comparison reuse a frame taken *before* that write.
    'move', 'click', 'drag', 'scroll', 'type', 'key', 'paste', 'focus',
    'invoke', 'set_value', 'select_text', 'toggle', 'select', 'expand', 'collapse', 'scroll_into_view',
    'close', 'minimize', 'maximize', 'restore', 'legacy_action', 'click_text'
)

# Steps that send synthesized input to *whatever happens to be in front*, as opposed to
# addressing a window or an element explicitly. Only these are affected by the
# window-change guard: a step that names its window (into_hwnd, a frame, a UIA handle)
# already checks its own target, and re-baselining on it is the caller's intent.
$FOREGROUND_STEP_ACTIONS = @('click', 'move', 'drag', 'scroll', 'type', 'key', 'paste', 'click_text')

function Test-ExpectedTransition($declared, [object]$live) {
    # Whether the window that just came forward is one the caller said it expects (B06).
    # Matching is by handle, by title substring, by process name or by pid, and the answer
    # names the rule that matched so the receipt can say *why* the batch was allowed to
    # continue into a window it did not start in. `any` / `*` accepts whatever appears.
    if ($null -eq $declared) { return $null }
    foreach ($entry in @($declared)) {
        if ($null -eq $entry) { continue }
        if ("$entry" -eq 'any' -or "$entry" -eq '*') { return [ordered]@{ matchedBy = 'any' } }
        $toRaw = Get-ConditionField $entry 'to'
        if ($null -ne $toRaw -and "$toRaw" -ne '' -and [int64]$toRaw -ne 0 -and [int64]$live.hwnd -eq [int64]$toRaw) {
            return [ordered]@{ matchedBy = "hwnd $toRaw" }
        }
        $title = "$(Get-ConditionField $entry 'title' '')"
        if ($title -ne '' -and "$($live.title)".IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [ordered]@{ matchedBy = "title~'$title'" }
        }
        $proc = "$(Get-ConditionField $entry 'process' '')"
        if ($proc -ne '' -and "$($live.process)".IndexOf($proc, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [ordered]@{ matchedBy = "process~'$proc'" }
        }
        $pidRaw = Get-ConditionField $entry 'pid'
        if ($null -ne $pidRaw -and "$pidRaw" -ne '' -and [int64]$pidRaw -ne 0) {
            $livePid = 0
            try { $livePid = [int](Get-WindowInfoForHwnd ([IntPtr][int64]$live.hwnd)).pid } catch { $livePid = 0 }
            if ($livePid -ne 0 -and [int64]$livePid -eq [int64]$pidRaw) { return [ordered]@{ matchedBy = "pid $pidRaw" } }
        }
    }
    return $null
}

function New-CaptureArgs([hashtable]$Base, [object]$Step = $null, [hashtable]$Extra = $null) {
    # One place where a capture request is assembled (sec. 5.4).
    #
    # A batch builds these hashtables in two places -- a step's capture and the trailing one --
    # and the two had already drifted: a step's capture never carried `regionSpace` or `clip`
    # (so `region_space: 'window'` and `clip: true` silently meant nothing inside a batch), and
    # the trailing capture dropped those *and* `surface` (so a batch asked for the client area
    # delivered the whole window as its result while its own steps delivered the client area).
    # The same request has to mean one thing wherever it is taken.
    #
    # Resolution order, stated once: the step's own argument, then the batch-level one, then
    # the default that was resolved before the batch started.
    $capture = @{}
    if ($null -ne $Base) { foreach ($key in $Base.Keys) { $capture[$key] = $Base[$key] } }
    if ($null -ne $Step) {
        $stepPath = "$($Step.path)"
        if ($stepPath -ne '') { $capture['path'] = $stepPath }
        if ($null -ne $Step.scale) { $capture['scale'] = [double]$Step.scale }
        if ($null -ne $Step.surface -and "$($Step.surface)" -ne '') { $capture['surface'] = "$($Step.surface)" }
        # Both spellings: the host writes regionSpace, a step written by hand may say
        # region_space, and a capture that quietly ignored one of them would be the same bug
        # in a new place.
        if ($null -ne $Step.regionSpace -and "$($Step.regionSpace)" -ne '') { $capture['regionSpace'] = "$($Step.regionSpace)" }
        elseif ($null -ne $Step.region_space -and "$($Step.region_space)" -ne '') { $capture['regionSpace'] = "$($Step.region_space)" }
        if ($null -ne $Step.clip) { $capture['clip'] = ($Step.clip -eq $true) }
        if ($null -ne $Step.region) { $capture['region'] = $Step.region }
        if ($null -ne $Step.window -and "$($Step.window)" -ne '' -and "$($Step.window)" -ne '0') {
            $capture['window'] = [int64]$Step.window
            $capture['requireWindow'] = $true
        }
        if ($null -ne $Step.display -and "$($Step.display)" -ne '') { $capture['display'] = $Step.display }
        if ($null -ne $Step.format -and "$($Step.format)" -ne '') { $capture['format'] = "$($Step.format)".ToLowerInvariant() }
        if ($null -ne $Step.quality) { $capture['quality'] = [int]$Step.quality }
        if ($null -ne $Step.settle_ms) { $capture['settleMs'] = [Math]::Max(0, [Math]::Min(5000, [int]$Step.settle_ms)) }
        if ($null -ne $Step.stability_ms) { $capture['stabilityMs'] = [Math]::Max(0, [Math]::Min($script:StabilityMaxMs, [int]$Step.stability_ms)) }
        if ($null -ne $Step.stable) { $capture['stable'] = $Step.stable }
    }
    if ($null -ne $Extra) { foreach ($key in $Extra.Keys) { $capture[$key] = $Extra[$key] } }
    return $capture
}

function Test-SameCaptureSpec([hashtable]$A, [hashtable]$B) {
    # Whether two capture requests are the same *picture* request (sec. 7.3): the reuse rule is
    # "this frame may stand in for the one this call was asked for", and a different rectangle,
    # scale, surface, space or clip is a different picture even when the moment is the same.
    if ($null -eq $A -or $null -eq $B) { return $false }
    foreach ($key in @('display', 'regionSpace', 'surface', 'clip', 'scale', 'format', 'quality', 'window', 'requireWindow')) {
        $left = if ($A.ContainsKey($key)) { "$($A[$key])" } else { '' }
        $right = if ($B.ContainsKey($key)) { "$($B[$key])" } else { '' }
        if ($left -ne $right) { return $false }
    }
    $leftRegion = if ($A.ContainsKey('region')) { $A['region'] } else { $null }
    $rightRegion = if ($B.ContainsKey('region')) { $B['region'] } else { $null }
    if (($null -eq $leftRegion) -ne ($null -eq $rightRegion)) { return $false }
    if ($null -ne $leftRegion) {
        foreach ($axis in @('x', 'y', 'width', 'height')) {
            if ("$(Get-ArgMember $leftRegion $axis)" -ne "$(Get-ArgMember $rightRegion $axis)") { return $false }
        }
    }
    return $true
}

function New-BatchProgress($steps, [int]$failedAt, [string]$failedState) {
    # What happened to every step, in the states a step can be in (sec. 5.2).
    #
    # The loop stops at the first failure, so the shape follows from where it stopped: every
    # step before it completed (the loop only ever advances past a step that returned), the
    # one it stopped at is named by `failedState`, and the ones after it never started. That
    # last distinction is the point -- "not-sent" means the caller's step was refused, while
    # "not-run" means it was never reached, and a caller deciding whether to send anything
    # again has to be able to tell them apart.
    $list = New-Object 'System.Collections.Generic.List[object]'
    for ($i = 0; $i -lt $steps.Count; $i++) {
        $action = "$($steps[$i].action)".ToLowerInvariant()
        $state = 'completed'
        if ($failedAt -ge 0) {
            if ($i -gt $failedAt) { $state = 'not-run' }
            elseif ($i -eq $failedAt) { $state = $failedState }
        }
        $list.Add([ordered]@{ step = [int]$i; action = $action; state = $state })
    }
    # Returned as a plain array and always taken back through `@(...)`: PowerShell unrolls a
    # collection on the way out of a function, so a one-step batch would otherwise arrive as
    # the step itself and the caller's `.ToArray()` would fail on it (found by
    # batch-progress-test).
    return $list.ToArray()
}

# ------------------------------------------------------------------ dry run (NEW-P1-02 B2)
#
# A rehearsal of a batch: everything a step does *up to the point where it would
# send input*, and nothing beyond it. Elements are located through the same engine
# the real step uses, frame points are projected through the same resolver with
# activation forced off (a rehearsal never raises a window), the window guard and
# the deadline arithmetic are the real ones, and the SendInput / pattern invoke /
# clipboard write that would move the desktop is replaced by a per-step verdict.
#
# The receipt carries dryRun=true in the envelope, has no `performed` list and
# reports action_sent=false -- a rehearsal can never be read as a batch that ran.
# Every verdict is an observation of *this* desktop *at rehearsal time* (per-step
# elapsedMs and the deadline fields let the host stamp the receipt's age): a
# verdict about a moving desktop does not stay true, and the receipt says so
# instead of pretending otherwise.

function Resolve-DryRunStepPoint([object]$step) {
    # The desktop point a coordinate step would use, without moving anything to it.
    # A frame point goes through the same resolver the real step uses, with
    # activation forced off: projecting is a read, raising a window is not.
    if (-not [string]::IsNullOrEmpty("$($step.from_frame)")) {
        $resolved = Resolve-FramePoint ([string]$step.from_frame) ([int]$step.x) ([int]$step.y) ([ordered]@{ allowActivate = $false; verifyContent = $step.verify_content; allowWindows = $step.allow_windows })
        if ($resolved.ok -ne $true) { throw "$($resolved.error)" }
        return [ordered]@{
            x     = [int]$resolved.x
            y     = [int]$resolved.y
            frame = [ordered]@{
                id      = "$($step.from_frame)"
                drift   = [int]$resolved.drift
                mapping = "$($resolved.mapping)"
                guard   = $resolved.guard
                note    = 'projected with activation suppressed (dry run)'
            }
        }
    }
    return [ordered]@{ x = [int]$step.x; y = [int]$step.y; frame = $null }
}

function Get-DryRunClickVia([object]$step, [int]$x, [int]$y) {
    # The strategy the real click would use at this point (the five constraints: via prediction). The
    # probe is the same read-only lookup Do-Click performs before choosing: the
    # accessibility press covers only the plain single left click, everything else
    # is a pointer gesture.
    $clicks = 1
    if ($null -ne $step.clicks) { $clicks = [int]$step.clicks }
    if ($clicks -lt 1) { $clicks = 1 }
    if ($clicks -gt 3) { $clicks = 3 }
    $button = "$($step.button)"
    if ([string]::IsNullOrWhiteSpace($button)) { $button = 'left' }
    $hasModifiers = (-not [string]::IsNullOrWhiteSpace("$($step.modifiers)"))
    if ($step.prefer_a11y -eq $false) { return [ordered]@{ via = 'mouse'; note = 'prefer_a11y is false, so the accessibility press is skipped by request' } }
    if ($clicks -ne 1 -or $button -ne 'left' -or $hasModifiers) {
        return [ordered]@{ via = 'mouse'; note = "the accessibility press covers only the plain single left click (clicks=$clicks, button=$button, modifiers=$hasModifiers)" }
    }
    $target = $null
    try { $target = Get-PressableElementAtPoint $x $y } catch { $target = $null }
    if ($null -ne $target) {
        return [ordered]@{ via = 'a11y'; note = "an InvokePattern element sits at that point ($($target.controlType) `"$($target.name)`")" }
    }
    return [ordered]@{ via = 'mouse'; note = 'no pressable element under the point, so the click would go out as synthesized input' }
}

function Test-DryRunForegroundTarget([object]$step, [int64]$cursorHwnd, [bool]$guardWindows, [string]$what) {
    # The into_hwnd check the real step runs (Assert-ExpectedForeground), mirrored.
    # When the guard is on, the comparison is against the window the rehearsal
    # believes the batch is in -- a focus or into_hwnd step before this one is
    # assumed to have done what it says. With the guard off the only honest answer
    # is the live foreground, the same thing the real run would check at send time.
    if ($null -eq $step.into_hwnd -or [int64]$step.into_hwnd -eq 0) { return }
    $want = [int64]$step.into_hwnd
    if ($guardWindows -and $cursorHwnd -gt 0) {
        if ($want -ne $cursorHwnd) {
            throw "[FRONT_NOT_TARGET] $what is aimed at hwnd $want but this batch would be in hwnd $cursorHwnd at that point (the rehearsal assumes earlier focus/into_hwnd steps do what they say). A real run checks the live foreground and refuses the same way. (in a real run: action_sent=false)"
        }
        return
    }
    $info = Get-InjectableForeground
    if ($null -eq $info) { throw "$what would go nowhere: no window holds the foreground. (in a real run: action_sent=false)" }
    if ([int64]$info.hwnd -ne $want) {
        $who = if ("$($info.title)" -ne '') { "`"$($info.title)`" [$($info.process)]" } else { "[$($info.process)]" }
        throw "[FRONT_NOT_TARGET] $what was aimed at hwnd $want but the foreground is hwnd $($info.hwnd) $who, which is what would receive it. (in a real run: action_sent=false)"
    }
}

function Get-DryRunUiaProbe([object]$step) {
    # A UIA step rehearsed: the element is resolved exactly as the real step
    # resolves it (a `ref` is re-located against the live tree, selectors go to the
    # same engine), and the pattern the action would drive is checked on the match.
    # Nothing is invoked, focused, selected, expanded or typed.
    $stepAction = "$($step.action)".ToLowerInvariant()
    # The same mapping Invoke-UiaStep performs, so the rehearsal asks the engine the
    # question the real step would ask.
    $a = @{}
    if ($null -ne $step.ref -and "$($step.ref)" -ne '') { $a.ref = "$($step.ref)" }
    if ($null -ne $step.hwnd) { $a.hwnd = [int64]$step.hwnd }
    if ($null -ne $step.automation_id) { $a.automationId = "$($step.automation_id)" }
    if ($null -ne $step.name) { $a.name = "$($step.name)" }
    if ($null -ne $step.control_type) { $a.controlType = "$($step.control_type)" }
    if ($null -ne $step.class_name) { $a.className = "$($step.class_name)" }
    if ($null -ne $step.element_index) { $a.index = [int]$step.element_index }
    if ($null -ne $step.text) { $a.text = "$($step.text)" }
    if ($null -ne $step.prefix) { $a.prefix = "$($step.prefix)" }
    if ($null -ne $step.suffix) { $a.suffix = "$($step.suffix)" }
    if ($null -ne $step.attempts) { $a.attempts = [int]$step.attempts }

    if ($null -ne $a.ref) {
        # The real step re-locates the ref against the live tree; the rehearsal does
        # the same read, so a stale ref fails here exactly as it would fail there.
        $resolved = Resolve-ElementRef ([string]$a.ref)
        if ($resolved.ok -ne $true) { throw "$($resolved.error)" }
        foreach ($key in @($resolved.selector.Keys)) { $a[$key] = $resolved.selector[$key] }
    }
    $hasSelector = (-not [string]::IsNullOrEmpty([string]$a.automationId)) -or
                   (-not [string]::IsNullOrEmpty([string]$a.name)) -or
                   (-not [string]::IsNullOrEmpty([string]$a.controlType)) -or
                   (-not [string]::IsNullOrEmpty([string]$a.className))
    if (-not $hasSelector) { throw "uiact needs at least one selector: automationId, name, controlType or className" }

    $targetHwnd = [int64]0
    if ($null -ne $a.hwnd) { $targetHwnd = [int64]$a.hwnd }
    if ($targetHwnd -eq 0) {
        $fgProbe = [DshNative]::GetForegroundWindow()
        if ($fgProbe -ne [IntPtr]::Zero) { $targetHwnd = [int64]$fgProbe }
    }
    if ($targetHwnd -eq 0) { throw 'no target window: the step names no hwnd and nothing holds the foreground' }

    $index = 0
    if ($null -ne $a.index) { $index = [int]$a.index }

    $engine = 'com'
    if ($env:DSH_COMPUTER_UI_ENGINE -eq 'managed') { $engine = 'managed' }
    if ($engine -eq 'com' -and -not $script:ComUiaReady) { $engine = 'managed' }

    $probe = [ordered]@{ via = 'uia'; engine = $engine; hwnd = $targetHwnd; matched = $null; pattern = ''; point = $null }

    if ($engine -eq 'com') {
        if ($stepAction -eq 'click_text' -or $stepAction -eq 'locate_text') {
            # Locate fully as the real run does: the real read-only locate runs, and click_text then walks
            # the same click-point fallback chain a real click would (OPT-P1-05,
            # shared by both) -- minus the click itself.
            $attempts = 8
            if ($null -ne $a.attempts) { $attempts = [Math]::Max(1, [Math]::Min(50, [int]$a.attempts)) }
            $rectX = 0; $rectY = 0; $rectW = 0; $rectH = 0; $foundText = ''; $matched = $null; $errorText = ''
            [DshUia.Engine]::LocateText($targetHwnd,
                [string]$a.automationId, [string]$a.name, [string]$a.controlType, [string]$a.className, $index,
                [string]$a.text, [string]$a.prefix, [string]$a.suffix, $attempts,
                [ref]$rectX, [ref]$rectY, [ref]$rectW, [ref]$rectH, [ref]$foundText, [ref]$matched, [ref]$errorText)
            if ($errorText -ne '') { throw $errorText }
            if ($null -ne $matched -and $matched.Count -gt 0) { $probe.matched = @(ConvertFrom-ComRows $matched)[0] }
            $probe.pattern = 'TextPattern (locate)'
            $probe.text = [ordered]@{ found = "$foundText"; rect = [ordered]@{ x = [int]$rectX; y = [int]$rectY; width = [int]$rectW; height = [int]$rectH } }
            if ($stepAction -eq 'click_text') {
                $chain = Get-ClickPointCandidates $targetHwnd ([int]$rectX) ([int]$rectY) ([int]$rectW) ([int]$rectH) $probe.matched
                if (-not $chain.ok) { throw "$($chain.error)" }
                $probe.point = $chain.point
                if ($chain.attempts.Count -gt 0) { $probe.pointAttempts = @($chain.attempts) }
            }
            return $probe
        }
        if ($stepAction -eq 'get_caret') {
            # A read, so it runs for real: the caret position a rehearsal reports is
            # one a caller would otherwise pay a second call to learn.
            $active = $false; $line = ''; $matched = $null; $errorText = ''
            $caretX = 0; $caretY = 0; $caretW = 0; $caretH = 0
            [DshUia.Engine]::ReadCaret($targetHwnd,
                [string]$a.automationId, [string]$a.name, [string]$a.controlType, [string]$a.className, $index,
                [ref]$active, [ref]$line, [ref]$caretX, [ref]$caretY, [ref]$caretW, [ref]$caretH, [ref]$matched, [ref]$errorText)
            if ($errorText -ne '') { throw $errorText }
            if ($null -ne $matched -and $matched.Count -gt 0) { $probe.matched = @(ConvertFrom-ComRows $matched)[0] }
            $probe.pattern = 'TextPattern2 (caret)'
            $probe.caret = [ordered]@{ active = [bool]$active; line = "$line" }
            if ($caretW -gt 0 -and $caretH -gt 0) { $probe.caret.rect = [ordered]@{ x = [int]$caretX; y = [int]$caretY; width = [int]$caretW; height = [int]$caretH } }
            return $probe
        }
        # Everything else: the element is resolved through the same Resolve and the
        # pattern the action drives is checked on it. Nothing is invoked.
        $matched = $null; $pattern = ''; $enabled = $false; $probeOk = $false; $errorText = ''
        [DshUia.Engine]::Probe($targetHwnd, $stepAction,
            [string]$a.automationId, [string]$a.name, [string]$a.controlType, [string]$a.className, $index,
            [ref]$matched, [ref]$pattern, [ref]$enabled, [ref]$probeOk, [ref]$errorText)
        if ($errorText -ne '') { throw $errorText }
        if (-not $probeOk) { throw 'the probe resolved the element but the pattern check did not conclude' }
        if ($null -ne $matched -and $matched.Count -gt 0) { $probe.matched = @(ConvertFrom-ComRows $matched)[0] }
        $probe.pattern = "$pattern"
        $probe.enabled = [bool]$enabled
        return $probe
    }

    # Managed fallback: the same find, the same pattern question, nothing invoked.
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = Get-UiaRoot ([ordered]@{ hwnd = $targetHwnd })
    $el = Find-UiaMatch $root $a
    $node = ConvertTo-Node $el 0
    $probe.matched = $node
    $reading = ($stepAction -eq 'get_value') -or ($stepAction -eq 'get_text') -or ($stepAction -eq 'locate_text') -or ($stepAction -eq 'get_caret')
    if ((-not $reading) -and ($node.enabled -ne $true)) {
        throw "the matched element is disabled ($(Get-NodeLabel $node)), so it would ignore the action; nothing was sent"
    }
    if ($stepAction -eq 'click_text' -or $stepAction -eq 'locate_text') {
        $located = Get-UiaTextRect $el $a ($stepAction -eq 'locate_text')
        $probe.pattern = 'TextPattern (locate)'
        $probe.text = [ordered]@{ found = "$($located.text)"; rect = [ordered]@{ x = [int]$located.x; y = [int]$located.y; width = [int]$located.width; height = [int]$located.height } }
        if ($stepAction -eq 'click_text') {
            $chain = Get-ClickPointCandidates $targetHwnd ([int]$located.x) ([int]$located.y) ([int]$located.width) ([int]$located.height) $node
            if (-not $chain.ok) { throw "$($chain.error)" }
            $probe.point = $chain.point
            if ($chain.attempts.Count -gt 0) { $probe.pointAttempts = @($chain.attempts) }
        }
        return $probe
    }
    if ($stepAction -eq 'get_caret') {
        # The managed wrapper has no TextPattern2 (Get-UiaCaret says the same); the
        # real step throws this sentence, and so does the rehearsal.
        throw 'the caret position needs TextPattern2, which the managed UI Automation wrapper does not expose; the COM engine (the default) can read it'
    }
    $patternType = $null
    $patternLabel = ''
    switch ($stepAction) {
        'invoke'           { $patternType = [System.Windows.Automation.InvokePattern]::Pattern; $patternLabel = 'Invoke' }
        'set_value'        { $patternType = [System.Windows.Automation.ValuePattern]::Pattern; $patternLabel = 'ValuePattern.SetValue' }
        'get_value'        { $patternType = [System.Windows.Automation.ValuePattern]::Pattern; $patternLabel = 'ValuePattern' }
        'toggle'           { $patternType = [System.Windows.Automation.TogglePattern]::Pattern; $patternLabel = 'Toggle' }
        'select'           { $patternType = [System.Windows.Automation.SelectionItemPattern]::Pattern; $patternLabel = 'SelectionItem' }
        'expand'           { $patternType = [System.Windows.Automation.ExpandCollapsePattern]::Pattern; $patternLabel = 'ExpandCollapse' }
        'collapse'         { $patternType = [System.Windows.Automation.ExpandCollapsePattern]::Pattern; $patternLabel = 'ExpandCollapse' }
        'scroll_into_view' { $patternType = [System.Windows.Automation.ScrollItemPattern]::Pattern; $patternLabel = 'ScrollItemPattern.ScrollIntoView (it is not inside a scrollable container)' }
        'close'            { $patternType = [System.Windows.Automation.WindowPattern]::Pattern; $patternLabel = 'WindowPattern (close/minimize/maximize/restore)' }
        'minimize'         { $patternType = [System.Windows.Automation.WindowPattern]::Pattern; $patternLabel = 'WindowPattern (close/minimize/maximize/restore)' }
        'maximize'         { $patternType = [System.Windows.Automation.WindowPattern]::Pattern; $patternLabel = 'WindowPattern (close/minimize/maximize/restore)' }
        'restore'          { $patternType = [System.Windows.Automation.WindowPattern]::Pattern; $patternLabel = 'WindowPattern (close/minimize/maximize/restore)' }
        'legacy_action'    { $patternType = [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern; $patternLabel = 'LegacyIAccessiblePattern.DoDefaultAction' }
        'get_text'         { $patternType = [System.Windows.Automation.TextPattern]::Pattern; $patternLabel = 'TextPattern' }
        'select_text'      { $patternType = [System.Windows.Automation.TextPattern]::Pattern; $patternLabel = 'TextPattern' }
        'focus'            { $patternType = $null; $patternLabel = 'element.SetFocus' }
        default            { throw "unknown UI Automation action '$stepAction'" }
    }
    if ($null -ne $patternType) {
        $p = $null
        if (-not $el.TryGetCurrentPattern($patternType, [ref]$p)) { throw "the matched element does not support $patternLabel" }
        $probe.pattern = $patternLabel
    } else {
        $probe.pattern = $patternLabel
    }
    $probe.enabled = ($node.enabled -eq $true)
    return $probe
}

function Invoke-BatchDryRun([object]$Arg, $steps, [hashtable]$captureBase, [int64]$deadlineMs, [int64]$deadlineAtMs, [bool]$guardWindows, [int64]$baselineHwnd, $expectedTransitions) {
    # The rehearsal loop. One verdict per step, in step order, and the loop never
    # stops early: the caller's question is "what in this sequence would fail", not
    # "where does it fail first" -- wouldStopAt carries that answer. Steps after a
    # refusal are rehearsed under the assumption that the earlier steps do what
    # they say (a focus step moves the rehearsal's idea of the foreground, and so
    # does an into_hwnd / hwnd-naming step -- exactly the baseline rule the real
    # loop applies), and the receipt's note states the assumption.
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $reports = New-Object System.Collections.Generic.List[object]
    $lines = New-Object System.Collections.Generic.List[string]
    $transitionReports = New-Object System.Collections.Generic.List[object]
    $allOk = $true
    $wouldStopAt = -1
    $outcome = 'dry-run'
    $cursorHwnd = [int64]$baselineHwnd
    # Simulated drag handle: a rehearsed drag dispatches nothing, so it cannot call
    # Set-DragHandle -- but a later continuation step in this same batch still needs
    # a start point. The endpoint of each rehearsed drag stands in for it.
    $dryDragHandle = $null
    $index = 0
    foreach ($step in $steps) {
        $action = "$($step.action)".ToLowerInvariant()
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $report = [ordered]@{ step = [int]$index; action = $action; verdict = 'ok'; dispatched = $false; detail = '' }
        try {
            # Cancellation is honored in a rehearsal too: a stopped caller should not
            # wait for the rest of the checks.
            Assert-NotCancelled "before dry-run of step $index ('$action')"
            # The deadline arithmetic is the real one (C04, sec. 5.7). The rehearsal
            # itself runs fast, so the honest reading of budgetLeftMs is "started
            # now, the real batch reaches this step with at most this much left".
            $leftForStep = Get-DeadlineRemainingMs
            if ($deadlineAtMs -gt 0) { $report.budgetLeftMs = [int]$leftForStep }
            if ($leftForStep -le 0) {
                $outcome = 'dry-run-deadline'
                throw "[DEADLINE_EXHAUSTED] the call's budget is spent before step $index ('$action') would start; a real run stops there and nothing after it is sent"
            }
            # The window guard, mirrored. A step that names its window (into_hwnd, a
            # frame) checks its own target instead; every other foreground step is
            # compared against the window the rehearsal believes the batch is in.
            if ($guardWindows -and ($FOREGROUND_STEP_ACTIONS -contains $action)) {
                $namesWindow = ($null -ne $step.into_hwnd) -or (-not [string]::IsNullOrEmpty("$($step.from_frame)"))
                if (-not $namesWindow) {
                    $live = Get-ForegroundInfo
                    if ([int64]$live.hwnd -eq 0) {
                        # Nothing holds the foreground: the step's own preflight says
                        # so with a better message than "the window changed".
                    } elseif ($cursorHwnd -eq 0) {
                        $cursorHwnd = [int64]$live.hwnd
                    } elseif ([int64]$live.hwnd -ne $cursorHwnd) {
                        $declared = Test-ExpectedTransition $expectedTransitions $live
                        if ($null -ne $declared) {
                            $transitionReports.Add([ordered]@{
                                atStep    = [int]$index
                                from      = [int64]$cursorHwnd
                                to        = [int64]$live.hwnd
                                title     = "$($live.title)"
                                process   = "$($live.process)"
                                matchedBy = "$($declared.matchedBy)"
                                note      = 'declared in expectedTransitions, so the batch would continue into this window'
                            })
                            $cursorHwnd = [int64]$live.hwnd
                        } else {
                            $nowTitle = "$($live.title)"
                            if ($nowTitle -eq '') { $nowTitle = '(untitled)' }
                            $outcome = 'dry-run-reobserve'
                            throw "the window in front is not the one this batch would be in: it is hwnd $($live.hwnd) [$($live.process)] `"$nowTitle`" before step $index ('$action'), and no expectedTransitions entry covers it. A real run stops here; observe again (computer_windows, computer_ui) and declare the transition, or pass stop_on_window_change: false. (in a real run: action_sent=false for this step)"
                        }
                    }
                }
            }
            switch ($action) {
                'click' {
                    # Do-Click runs Get-KeyVkList on the modifiers chord before sending,
                    # so an unknown key name refuses the real step. The rehearsal parses
                    # the same chord -- reporting ok here would be a false pass.
                    if (-not [string]::IsNullOrWhiteSpace("$($step.modifiers)")) { [void](Get-KeyVkList "$($step.modifiers)") }
                    $p = Resolve-DryRunStepPoint $step
                    if (-not (Test-PointOnDesktop ([int]$p.x) ([int]$p.y))) {
                        # The real click does not refuse an off-desktop point -- Windows
                        # clamps the pointer to the nearest edge and the click lands
                        # somewhere unintended. That is a fact worth saying, not a place
                        # to stop.
                        $report.warning = "($($p.x),$($p.y)) is outside the virtual desktop; a real click there would be clamped to the nearest edge and land somewhere you did not choose"
                    }
                    $viaProbe = Get-DryRunClickVia $step ([int]$p.x) ([int]$p.y)
                    $report.point = [ordered]@{ x = [int]$p.x; y = [int]$p.y }
                    $report.via = "$($viaProbe.via)"
                    $report.detail = "$($viaProbe.note)"
                    if ($null -ne $p.frame) { $report.frame = $p.frame }
                }
                'move' {
                    if (($null -ne $step.dx) -or ($null -ne $step.dy)) {
                        $report.detail = 'a relative move names no point, so there is nothing to locate; the pointer would move by the delta from wherever it is when the step runs'
                    } else {
                        $p = Resolve-DryRunStepPoint $step
                        if (-not (Test-PointOnDesktop ([int]$p.x) ([int]$p.y))) {
                            $report.warning = "($($p.x),$($p.y)) is outside the virtual desktop; the pointer would be clamped to the nearest edge"
                        }
                        $report.point = [ordered]@{ x = [int]$p.x; y = [int]$p.y }
                        if ($null -ne $p.frame) { $report.frame = $p.frame }
                        $report.detail = 'the point is on the desktop; the pointer would be moved (a write: hover, tooltip and focus follow it)'
                    }
                }
                'drag' {
                    # Do-Drag parses the modifiers chord too (Get-KeyVkList), so an
                    # unknown key name refuses the real step; mirror that here.
                    if (-not [string]::IsNullOrWhiteSpace("$($step.modifiers)")) { [void](Get-KeyVkList "$($step.modifiers)") }
                    # Continuation ("from_last"/"continue_from"): the real run takes the
                    # start from the drag handle (Get-DragHandle) and refuses when it is
                    # missing or stale, before any input is sent. Taking (0,0) as the
                    # start here would report ok for a step the real run refuses, so the
                    # rehearsal mirrors the handle: a drag rehearsed earlier in this same
                    # batch leaves a simulated handle; otherwise the worker's real handle
                    # is consulted and the same refusal is raised. (Get-DragHandle clears
                    # a stale handle as a side effect -- the real run does the same when
                    # it reaches this step, and a stale handle is unusable either way.)
                    $fromLast = ($null -ne $step.fromLast) -and ($step.fromLast -eq $true -or "$($step.fromLast)" -eq 'true')
                    $continueFrom = ''
                    if ($null -ne $step.continueFrom) { $continueFrom = "$($step.continueFrom)" }
                    $contStart = $null
                    $contNote = ''
                    if ($fromLast -or $continueFrom -ne '') {
                        if ($null -ne $dryDragHandle) {
                            $contStart = $dryDragHandle
                            $contNote = " (continued from the drag rehearsed earlier in this batch, at ($([int]$contStart.x),$([int]$contStart.y)))"
                        } else {
                            $handle = Get-DragHandle $continueFrom
                            if (-not $handle.ok) { throw "[$($handle.code)] cannot continue from the last drag: $($handle.note). (action_sent=false, recovery=computer_screenshot, auto_reresolve=false)" }
                            $contStart = $handle.handle
                            $contNote = " (continued from drag handle $($handle.handle.id), at ($([int]$contStart.x),$([int]$contStart.y)))"
                        }
                    }
                    $frameNote = ''
                    $path = @()
                    if ($null -ne $step.path) {
                        foreach ($point in @($step.path)) {
                            $px = Get-ArgMember $point 'x'
                            $py = Get-ArgMember $point 'y'
                            if ($null -eq $px -or $null -eq $py) { throw "[BAD_REQUEST] every point of a drag path needs x and y" }
                            $path += [ordered]@{ x = [int]$px; y = [int]$py }
                        }
                        if ($path.Count -lt 2) { throw "[BAD_REQUEST] a drag path needs at least two points (got $($path.Count))" }
                        if ($path.Count -gt 64) { throw "[BAD_REQUEST] a drag path takes at most 64 points (got $($path.Count)); simplify it" }
                    }
                    if ($path.Count -gt 0) {
                        if (-not [string]::IsNullOrEmpty("$($step.from_frame)")) {
                            # The real drag projects every path point before the button
                            # goes down; the rehearsal projects them the same way, with
                            # activation forced off.
                            $projected = @()
                            foreach ($point in $path) {
                                $rp = Resolve-FramePoint ([string]$step.from_frame) ([int]$point.x) ([int]$point.y) ([ordered]@{ allowActivate = $false; verifyContent = $step.verify_content; allowWindows = $step.allow_windows })
                                if ($rp.ok -ne $true) { throw "$($rp.error)" }
                                $projected += [ordered]@{ x = [int]$rp.x; y = [int]$rp.y }
                            }
                            $path = $projected
                            $frameNote = " (projected from frame $($step.from_frame), activation suppressed)"
                        }
                        foreach ($point in $path) {
                            if (-not (Test-PointOnDesktop ([int]$point.x) ([int]$point.y))) {
                                $report.warning = "path point ($($point.x),$($point.y)) is outside the virtual desktop; the pointer would be clamped to the nearest edge there"
                                break
                            }
                        }
                        $last = $path[$path.Count - 1]
                        $report.point = [ordered]@{ x = [int]$path[0].x; y = [int]$path[0].y }
                        $report.detail = "a $($path.Count)-point path$frameNote, from ($($path[0].x),$($path[0].y)) to ($($last.x),$($last.y))"
                        if ($null -ne $contStart) { $report.detail += "; the continuation handle was validated, but a path starts at its own first point (the real run overrides the continued start the same way)" }
                        # The real drag records its endpoint as the next continuation
                        # handle; the rehearsal mirrors that with a simulated handle.
                        $dryDragHandle = [ordered]@{ x = [int]$last.x; y = [int]$last.y }
                    } else {
                        $sx = [int]$step.from_x
                        $sy = [int]$step.from_y
                        if ($null -ne $contStart) { $sx = [int]$contStart.x; $sy = [int]$contStart.y }
                        $ex = [int]$step.to_x
                        $ey = [int]$step.to_y
                        if (-not [string]::IsNullOrEmpty("$($step.from_frame)")) {
                            $rs = Resolve-FramePoint ([string]$step.from_frame) $sx $sy ([ordered]@{ allowActivate = $false; verifyContent = $step.verify_content; allowWindows = $step.allow_windows })
                            if ($rs.ok -ne $true) { throw "$($rs.error)" }
                            $re2 = Resolve-FramePoint ([string]$step.from_frame) $ex $ey ([ordered]@{ allowActivate = $false; verifyContent = $step.verify_content; allowWindows = $step.allow_windows })
                            if ($re2.ok -ne $true) { throw "$($re2.error)" }
                            $sx = [int]$rs.x; $sy = [int]$rs.y
                            $ex = [int]$re2.x; $ey = [int]$re2.y
                            $frameNote = " (projected from frame $($step.from_frame), activation suppressed)"
                        }
                        if (-not (Test-PointOnDesktop $sx $sy)) { $report.warning = "the drag starts at ($sx,$sy), outside the virtual desktop; the pointer would be clamped to the nearest edge" }
                        if (-not (Test-PointOnDesktop $ex $ey)) { $report.warning = "the drag ends at ($ex,$ey), outside the virtual desktop; the pointer would be clamped to the nearest edge" }
                        $report.point = [ordered]@{ x = [int]$sx; y = [int]$sy }
                        $report.detail = "($sx,$sy) -> ($ex,$ey)$frameNote$contNote"
                        $dryDragHandle = [ordered]@{ x = [int]$ex; y = [int]$ey }
                    }
                }
                'scroll' {
                    if (($null -ne $step.x) -and ($null -ne $step.y)) {
                        $p = Resolve-DryRunStepPoint $step
                        if (-not (Test-PointOnDesktop ([int]$p.x) ([int]$p.y))) {
                            $report.warning = "($($p.x),$($p.y)) is outside the virtual desktop; the pointer would be clamped to the nearest edge"
                        }
                        $report.point = [ordered]@{ x = [int]$p.x; y = [int]$p.y }
                        if ($null -ne $p.frame) { $report.frame = $p.frame }
                        $report.detail = "would scroll $($step.direction) at ($($p.x),$($p.y))"
                    } else {
                        $report.detail = "would scroll $($step.direction) at wherever the pointer is when the step runs (the step names no point)"
                    }
                }
                'type' {
                    Test-DryRunForegroundTarget $step $cursorHwnd $guardWindows 'typing'
                    $report.detail = "would type $($("$($step.text)").Length) char(s)"
                    if ($null -ne $step.into_hwnd) { $report.detail += " into hwnd $([int64]$step.into_hwnd)" }
                }
                'key' {
                    # The chord parse is the real validation the send path uses.
                    $vk = Get-KeyVkList "$($step.keys)"
                    Test-DryRunForegroundTarget $step $cursorHwnd $guardWindows 'key press'
                    $report.detail = "would press '$($step.keys)' ($($vk.Count) virtual key(s))"
                    if ($null -ne $step.into_hwnd) { $report.detail += " into hwnd $([int64]$step.into_hwnd)" }
                }
                'paste' {
                    Test-DryRunForegroundTarget $step $cursorHwnd $guardWindows 'paste'
                    $report.detail = "would stage $($("$($step.text)").Length) char(s) on the clipboard and paste them -- the clipboard write is the part the rehearsal does not do"
                    if ($null -ne $step.into_hwnd) { $report.detail += " into hwnd $([int64]$step.into_hwnd)" }
                }
                'focus' {
                    $fh = [int64]$step.hwnd
                    if (-not [DshNative]::IsWindow([IntPtr]$fh)) { throw "hwnd $fh is not a window any more; list windows with computer_windows and use a current handle" }
                    $focusInfo = Get-WindowInfoForHwnd ([IntPtr]$fh)
                    $report.hwnd = $fh
                    $report.detail = "would raise and focus hwnd $fh (`"$($focusInfo.title)`" [$($focusInfo.process)])"
                    if ($guardWindows) { $cursorHwnd = $fh }
                }
                'clipboard' {
                    $op = "$($step.op)".ToLowerInvariant()
                    # A missing op defaults to 'get' in the real batch loop; the rehearsal
                    # names the same default instead of reporting a phantom op.
                    if ($op -eq '') { $op = 'get' }
                    if ($op -eq 'get') {
                        $report.detail = 'not read (dry run): the clipboard a real run reads here is the one the earlier steps left behind, and reading it now would describe the wrong moment'
                    } elseif ($op -eq 'set') {
                        $report.detail = "not staged (dry run): the clipboard would be set to $($("$($step.text)").Length) char(s)"
                    } elseif ($op -eq 'clear') {
                        $report.detail = 'not cleared (dry run): the clipboard write is the part the rehearsal does not do'
                    } else {
                        # Unreachable while the shared preflight above validates the op
                        # enumeration; kept so this branch never reports ok for an op the
                        # real run refuses.
                        throw "clipboard op must be 'get', 'set' or 'clear'"
                    }
                }
                'wait' {
                    $wantedMs = [int]([double]$step.seconds * 1000)
                    $left = Get-DeadlineRemainingMs
                    $report.detail = "would wait $($step.seconds)s (not slept)"
                    if ($deadlineAtMs -gt 0 -and $left -lt $wantedMs) {
                        $report.detail = "would wait $($step.seconds)s, but the call's deadline leaves $left ms -- a real run waits only that and reports deadline-partial"
                    }
                }
                'wait_for' {
                    $waitSpec = Get-WaitConditionSpec $step
                    $probe = Test-ConditionPredicate $waitSpec.condition
                    $satisfied = ("$($probe.status)" -eq 'true')
                    $clip = ''
                    if ($deadlineAtMs -gt 0) {
                        $left = Get-DeadlineRemainingMs
                        if ([int]$waitSpec.timeoutMs -gt $left) { $clip = "; the call's deadline would clip the wait to $left ms" }
                    }
                    if ($satisfied) {
                        $report.detail = "satisfied right now ($($probe.observed))"
                    } else {
                        $report.detail = "not satisfied right now (status: $($probe.status); $($probe.observed)) -- a real run would poll up to $($waitSpec.timeoutMs) ms for it$clip"
                        if ("$($step.on_timeout)" -eq 'continue') { $report.detail += ', then continue anyway (on_timeout: continue)' }
                        else { $report.detail += ', and stop the batch with CONDITION_TIMEOUT if it stays unsatisfied' }
                    }
                    $report.wait = [ordered]@{ satisfied = [bool]$satisfied; status = "$($probe.status)"; observed = "$($probe.observed)"; timeoutMs = [int]$waitSpec.timeoutMs; timeoutFrom = "$($waitSpec.timeoutFrom)" }
                }
                'screenshot' {
                    $capture = New-CaptureArgs $captureBase $step
                    if ($capture.ContainsKey('window') -and [int64]$capture['window'] -ne 0) {
                        if (-not [DshNative]::IsWindow([IntPtr][int64]$capture['window'])) { throw "hwnd $($capture['window']) is not a window any more; list windows with computer_windows and use a current handle" }
                    }
                    $report.capture = [ordered]@{ path = "$($capture['path'])"; format = "$($capture['format'])"; scale = [double]$capture['scale'] }
                    if ($capture.ContainsKey('window')) { $report.capture.window = [int64]$capture['window'] }
                    $report.detail = "not taken (dry run): a real run would capture to '$($capture['path'])' (format $($capture['format']), scale $($capture['scale']))"
                }
                default {
                    if (-not ($UIA_STEP_ACTIONS -contains $action)) { throw "[BAD_REQUEST] unknown step action '$action'" }
                    $probe = Get-DryRunUiaProbe $step
                    $report.via = 'uia'
                    $report.engine = "$($probe.engine)"
                    $report.hwnd = [int64]$probe.hwnd
                    if ($null -ne $probe.matched) { $report.matched = $probe.matched }
                    if ("$($probe.pattern)" -ne '') { $report.pattern = "$($probe.pattern)" }
                    if ($null -ne $probe.point) { $report.point = $probe.point }
                    if ($null -ne $probe.pointAttempts) { $report.pointAttempts = @($probe.pointAttempts) }
                    $label = Get-NodeLabel $probe.matched
                    if (($action -eq 'locate_text') -or ($action -eq 'click_text')) {
                        $tr = $probe.text.rect
                        $report.text = [ordered]@{ found = "$($probe.text.found)"; rect = $tr }
                        $report.detail = "located `"$($probe.text.found)`" at $($tr.x),$($tr.y) ($($tr.width)x$($tr.height)) on $label"
                        if ($action -eq 'click_text' -and $null -ne $probe.point) {
                            $report.detail = "would click `"$($probe.text.found)`" at ($($probe.point.x),$($probe.point.y)) [$($probe.point.level)] on $label"
                        }
                    } elseif ($action -eq 'get_caret') {
                        $report.caret = $probe.caret
                        $report.detail = "caret on $label (active: $($probe.caret.active))"
                    } else {
                        $report.detail = "would $action $label"
                        if ("$($probe.pattern)" -ne '') { $report.detail += " ($($probe.pattern) present)" }
                    }
                }
            }
            # The baseline moves the way the real loop moves it (12-batching.ps1
            # L887-892): a step that names its window moves the batch there on
            # purpose, and the guard follows it.
            if ($guardWindows) {
                if ($null -ne $step.into_hwnd) { $cursorHwnd = [int64]$step.into_hwnd }
                elseif (($UIA_STEP_ACTIONS -contains $action) -and $null -ne $step.hwnd) { $cursorHwnd = [int64]$step.hwnd }
            }
        } catch {
            $report.verdict = 'refused'
            $report.detail = "$($_.Exception.Message)"
            if ($allOk) { $wouldStopAt = [int]$index }
            $allOk = $false
        }
        $sw.Stop()
        $report.elapsedMs = [int]$sw.ElapsedMilliseconds
        $reports.Add($report)
        $lines.Add("step $index ${action}: $($report.verdict) -- $($report.detail)")
        $index += 1
    }

    $reply = [ordered]@{
        # dryRun is the unmixable marker: a receipt that carries it never ran, and a
        # receipt that ran never carries it (NEW-P1-02 B2, constraint four).
        dryRun      = $true
        outcome     = $outcome
        allOk       = $allOk
        wouldStopAt = [int]$wouldStopAt
        count       = [int]$steps.Count
        steps       = @($reports.ToArray())
        lines       = @($lines.ToArray())
        action_sent = $false
        wroteSteps  = @()
        elapsedMs   = [int]$stopwatch.ElapsedMilliseconds
        note        = 'dry run: every check ran for real and nothing was dispatched. Verdicts describe the desktop at rehearsal time; steps after a refusal were rehearsed assuming the earlier steps do what they say. wouldStopAt names the first step a real run would refuse (-1: none).'
    }
    if ($transitionReports.Count -gt 0) { $reply.transitions = @($transitionReports.ToArray()) }
    if ($deadlineMs -gt 0) {
        $reply.deadlineMs = [int]$deadlineMs
        $reply.deadlineLeftMs = [int](Get-DeadlineRemainingMs)
    }
    # The trailing observations answer questions about the desktop *after* the
    # steps, which a rehearsal never produces -- so they are reported, not taken.
    if ($null -ne $Arg.waitFor) { $reply.waitFor = 'not evaluated (dry run): the batch-level condition describes the desktop after the steps, which a rehearsal never produces' }
    if (($Arg.screenshot -eq $true) -or ($null -ne $Arg.state)) {
        $trailing = [ordered]@{}
        if ($Arg.screenshot -eq $true) { $trailing.screenshot = 'not taken (dry run)' }
        if ($null -ne $Arg.state) { $trailing.state = 'not read (dry run)' }
        $reply.trailing = $trailing
    }
    Clear-Deadline
    return $reply
}

function Do-Batch([object]$Arg) {
    # One round trip for a whole gesture. The transport floor here is 1-3 ms, so
    # batching is not about the pipe: it is about the model only having to make one
    # decision-and-observe cycle instead of one per action. Any agent that drives a
    # desktop spends its budget the same way -- the round trips dominate, not the bytes.
    $steps = @($Arg.steps)
    if ($steps.Count -eq 0) { throw "batch requires at least one step" }
    # One deadline for the whole call (C04). Every wait inside the batch -- a step's own
    # `wait`, a `wait_for` condition step, the batch-level condition, the pacing of the
    # trailing capture -- is bounded by what is left of it, so a batch cannot exceed the
    # budget it was given by adding up per-step timeouts. Without this, five steps of
    # "30 s each" claim two and a half minutes while the caller sits under one transport
    # budget, and the batch is cut off from outside with nothing in the reply to show it.
    $deadlineMs = [int64]0
    if ($null -ne $Arg.deadlineMs -and "$($Arg.deadlineMs)" -ne '') { $deadlineMs = [int64]$Arg.deadlineMs }
    $deadlineAtMs = [int64]0
    if ($deadlineMs -gt 0) { $deadlineAtMs = [int64]$script:Clock.ElapsedMilliseconds + $deadlineMs }
    # Published for the input functions this batch calls (sec. 5.7): a step that starts before the
    # deadline can still run past it, and the refusal has to land before the *send*, not after
    # the batch has already typed into a call whose time was spent.
    Set-DeadlineAt $deadlineAtMs
    # The windows this batch is allowed to end up in, when the caller says so (B06): a
    # dialog it is going to open, an "export complete" box it is waiting for.
    $expectedTransitions = $Arg.expectedTransitions
    $transitions = New-Object System.Collections.Generic.List[object]
    $outcome = 'ok'
    $nextStep = -1
    # Which steps actually put something into the desktop, in order. This is the fact behind
    # `action_sent`: it is not the same question as "did the batch succeed", and it is the
    # one a caller needs before deciding whether to retry (B07).
    $wroteSteps = New-Object System.Collections.Generic.List[int]
    # The settle floor and the stability budget are resolved once for the whole call and
    # handed to every capture in it, including a batch-level default the steps can override:
    # before this, a capture inside a batch could only ever use the worker default, so the
    # "0 disables the poll" knob the single-step tool had did not reach it.
    $settleMs = $script:PostActionMs
    if ($null -ne $Arg.settleMs) { $settleMs = [Math]::Max(0, [Math]::Min(5000, [int]$Arg.settleMs)) }
    $stabilityMs = $null
    if ($null -ne $Arg.stabilityMs) { $stabilityMs = [Math]::Max(0, [Math]::Min($script:StabilityMaxMs, [int]$Arg.stabilityMs)) }
    $stableFlag = $null
    if ($null -ne $Arg.stable) { $stableFlag = $Arg.stable }
    $defaultPath = [string]$Arg.path
    $display = $Arg.display
    $region = $Arg.region
    # What the batch's captures are *of*, when the caller says so. Without these a
    # trailing capture could only ever be the whole screen: "do these steps, then show me
    # the panel" cost a second round trip, because the frame could not be aimed at the
    # panel the batch had just produced.
    $captureWindow = [int64]0
    if ($null -ne $Arg.window) { $captureWindow = [int64]$Arg.window }
    # The bridge spells it requireWindow; the host's schema uses require_window. Both
    # reach here, and a capture that silently gave up the window's own pixels because the
    # spelling differed would be a guarantee quietly downgraded.
    $requireWindow = ($Arg.requireWindow -eq $true) -or ($Arg.require_window -eq $true)
    if ($null -ne $Arg.display) { $display = $Arg.display }
    if ($null -ne $Arg.region) { $region = $Arg.region }
    $format = 'png'
    if ($null -ne $Arg.format -and "$($Arg.format)" -ne '') { $format = "$($Arg.format)".ToLowerInvariant() }
    $quality = 85
    if ($null -ne $Arg.quality) { $quality = [int]$Arg.quality }
    $scale = 1.0
    if ($null -ne $Arg.scale) { $scale = [double]$Arg.scale }
    # The batch-level capture request, resolved once (sec. 5.4). Every capture this call takes --
    # a step's, the trailing one -- starts from this and changes only what that capture is
    # about. `regionSpace` and `clip` belong here: the host has always sent them at the
    # batch level, and until they were read here a batch that asked for a window-local
    # rectangle (or for the part of it that exists) silently captured something else.
    $captureBase = @{
        path = $defaultPath
        display = $display
        region = $region
        regionSpace = "$($Arg.regionSpace)"
        surface = "$($Arg.surface)"
        clip = ($Arg.clip -eq $true)
        format = $format
        quality = $quality
        scale = $scale
        settleMs = $settleMs
        stabilityMs = $stabilityMs
        stable = $stableFlag
    }
    if ($captureWindow -ne 0) {
        $captureBase['window'] = $captureWindow
        $captureBase['requireWindow'] = $requireWindow
    }

    $performed = New-Object System.Collections.Generic.List[string]
    $shot = $null
    # One report per `wait_for` step, in step order: what was waited for, whether it
    # became true, how long that took, and what the final observation saw.
    $waitReports = New-Object 'System.Collections.Generic.List[object]'
    $usefulCapture = $null
    $index = 0
    # Where the time goes, in the only place that can measure it: the steps, the trailing
    # capture and the encode all happen in here, and the caller otherwise sees one number
    # for the whole call with no way to tell which part is slow.
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    # The window the batch believes it is driving, and the guard around it.
    #
    # A batch is the one call where the model is *not* looking: it handed over a sequence
    # and is waiting for the result. If a dialog appears or the app navigates in the middle
    # of that sequence, every remaining step would be typed or clicked into a window the
    # caller never chose -- the most expensive failure in this whole loop, because it looks
    # like success. So the foreground is compared against the window this batch started in
    # before each step that would send input to whatever is in front, and a change stops the
    # batch there: the steps that ran are reported, the ones that did not are named, and the
    # caller is told to observe before continuing. `focus` steps (and steps that name a
    # window) move the baseline, because naming the window *is* the caller's decision, and
    # `stopOnWindowChange: false` turns the whole guard off for a sequence that deliberately
    # walks through a window it expects to appear.
    $guardWindows = $Arg.stopOnWindowChange -ne $false
    # NEW-P1-02 B2: a rehearsal runs every check and no dispatch. The host spells
    # it dryRun; a hand-written request may say dry_run.
    $dryRun = ($Arg.dryRun -eq $true) -or ($Arg.dry_run -eq $true)
    $baselineHwnd = [int64]0
    if ($guardWindows) {
        $baselineProbe = Get-ForegroundInfo
        $baselineHwnd = [int64]$baselineProbe.hwnd
    }

    # Visual evidence: the one thing a synthesized event cannot report is whether
    # anything actually happened. Fingerprint the same rectangle before and after,
    # so "the click was delivered" and "the screen changed" stay separate facts.
    $evidence = $null
    $digestRect = $null
    $digestBefore = ''
    if ($Arg.evidence -ne $false -and -not $dryRun) {
        foreach ($step in $steps) {
            if ($WRITE_STEP_ACTIONS -contains "$($step.action)".ToLowerInvariant()) {
                $digestRect = Get-ForegroundRect
                $digestBefore = Get-RegionDigest $digestRect.x $digestRect.y $digestRect.width $digestRect.height 320
                break
            }
        }
    }
    # The last step that writes, and whether any capture can stand in for the "after"
    # reading. A capture doubles as evidence only when it covers the same rectangle *and*
    # happens after the last write: a frame from the wrong region, or from before the
    # action, would make the comparison say something false. When no capture qualifies,
    # the reading is taken separately exactly as before.
    $lastWriteIndex = -1
    for ($writeScan = 0; $writeScan -lt $steps.Count; $writeScan++) {
        if ($WRITE_STEP_ACTIONS -contains "$($steps[$writeScan].action)".ToLowerInvariant()) { $lastWriteIndex = $writeScan }
    }
    # ...and *when* it happened. The index alone answers "did any capture step come
    # after it", which is the wrong question for the trailing capture: that one is
    # reported as soon as a mid-batch step took a picture, so a batch that shot the
    # screen at step 2 and clicked at step 5 handed back the step-2 frame as "the
    # result of this call". What settles it is the write ordinal the frame was taken
    # against (see Test-CaptureAfterWrite), not the step index.
    # Which step produced the frame this reply returns, kept *with* the frame (sec. 5.6). -1 means
    # "no screenshot step produced this frame" (it came from the trailing capture, or from none
    # at all).
    $frameStepIndex = -1
    $evidenceRect = $null
    $evidenceDigest = ''
    if ($null -ne $digestRect) {
        $evidenceRect = [ordered]@{
            x       = [int]$digestRect.x
            y       = [int]$digestRect.y
            width   = [int]$digestRect.width
            height  = [int]$digestRect.height
            maxSide = 320
        }
    }

    function Get-BatchRemainingMs {
        # What is left of this call's deadline, or "unbounded" when it was given none. The
        # steps use it so the batch's waits share one budget instead of each claiming its
        # own (C04).
        if ($deadlineAtMs -le 0) { return [int]::MaxValue }
        $left = [int64]$deadlineAtMs - [int64]$script:Clock.ElapsedMilliseconds
        if ($left -lt 0) { $left = 0 }
        return [int]$left
    }

    function Complete-Evidence {
        if ($null -eq $digestRect) { return $null }
        $after = ''
        $reused = $false
        if ("$evidenceDigest" -ne '') {
            # Already fingerprints of exactly this rectangle, taken while the frame was in
            # the capture path's hands. Nothing is re-grabbed for them.
            $after = "$evidenceDigest"
            $reused = $true
        } else {
            $after = Get-RegionDigest $digestRect.x $digestRect.y $digestRect.width $digestRect.height 320
        }
        return [ordered]@{
            changed = ($after -ne $digestBefore)
            before  = $digestBefore
            after   = $after
            reused  = $reused
            x       = $digestRect.x
            y       = $digestRect.y
            width   = $digestRect.width
            height  = $digestRect.height
        }
    }

    function Settle-Before-Capture {
        # Intentionally empty, and the reason has changed with the pacing: the capture itself
        # waits. Do-Screenshot applies the settle floor to the write stamp and runs the
        # stability poll with the budget this batch resolved, so a second wait here would be
        # a second sleep in front of the same capture -- with a *different* budget than the
        # one the caller asked for, which is how a batch's captures used to end up on the
        # worker default no matter what the call said.
    }

    # Every step is validated before the first one runs. A batch is one call, so a
    # step 6 that could never work -- a typo'd action, a drag missing its end point --
    # used to be discovered after steps 1-5 had already moved the desktop, and the
    # caller had no way to tell how far it got without reading the log. Refusing the
    # whole call up front costs nothing and is the only version a caller can recover
    # from by fixing its arguments.
    $stepIndex = 0
    foreach ($candidate in $steps) {
        $candidateAction = "$($candidate.action)".ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($candidateAction)) { throw "[BAD_REQUEST] step $stepIndex has no action" }
        if (-not ($STEP_ACTIONS -contains $candidateAction)) {
            throw "[BAD_REQUEST] unknown step action '$candidateAction' at step $stepIndex; known actions: $($STEP_ACTIONS -join ', ')"
        }
        switch ($candidateAction) {
            'move'      {
                # Three ways to move, and a step names exactly one: a destination point, a
                # delta (sec. 9), or an image point through a frame.
                $hasDelta = ($null -ne $candidate.dx) -or ($null -ne $candidate.dy)
                $hasPoint = ($null -ne $candidate.x) -and ($null -ne $candidate.y)
                $hasFrame = -not [string]::IsNullOrEmpty("$($candidate.from_frame)")
                if ($hasDelta -and ($hasPoint -or $hasFrame)) {
                    throw "[BAD_REQUEST] step $stepIndex is a relative move (dx/dy) that also names a point: pass either a delta or a destination"
                }
                if (-not $hasDelta -and -not $hasPoint -and -not $hasFrame) {
                    throw "[BAD_REQUEST] step $stepIndex is a move without x and y (or dx/dy for a relative move)"
                }
            }
            'click'     { if ($null -eq $candidate.x -and [string]::IsNullOrEmpty("$($candidate.from_frame)")) { throw "[BAD_REQUEST] step $stepIndex is a click with neither x/y nor from_frame" } }
            'drag'      {
                # sec. 8 second half: a continued stroke starts from the last landing point, so from_x/from_y are not required here (only the destination).
                $continues = ($null -ne $candidate.fromLast -and "$($candidate.fromLast)" -eq 'true') -or -not [string]::IsNullOrEmpty("$($candidate.continueFrom)")
                if ($null -eq $candidate.to_x -or $null -eq $candidate.to_y) { throw "[BAD_REQUEST] step $stepIndex is a drag without to_x and to_y" }
                if (-not $continues -and ($null -eq $candidate.from_x -or $null -eq $candidate.from_y)) { throw "[BAD_REQUEST] step $stepIndex is a drag without from_x, from_y, to_x and to_y (or from_last/continue_from for a continued stroke)" }
            }
            'scroll'    { if ([string]::IsNullOrWhiteSpace("$($candidate.direction)")) { throw "[BAD_REQUEST] step $stepIndex is a scroll without a direction" } }
            'type'      { if ($null -eq $candidate.text) { throw "[BAD_REQUEST] step $stepIndex is a type without text" } }
            'paste'     { if ([string]::IsNullOrEmpty("$($candidate.text)")) { throw "[BAD_REQUEST] step $stepIndex is a paste without text" } }
            'key'       { if ([string]::IsNullOrWhiteSpace("$($candidate.keys)")) { throw "[BAD_REQUEST] step $stepIndex is a key press without keys" } }
            'focus'     { if ($null -eq $candidate.hwnd) { throw "[BAD_REQUEST] step $stepIndex is a focus without hwnd" } }
            'wait'      { if ($null -eq $candidate.seconds) { throw "[BAD_REQUEST] step $stepIndex is a wait without seconds" } }
            'wait_for'  {
                # A condition step carries its predicate either inline or under
                # `condition`; both spellings reach Wait-ForCondition, and the refusal
                # is stated once so a caller learns a single rule.
                $cond = $candidate.condition
                if ($null -eq $cond) { $cond = $candidate }
                $hasPredicate = ($null -ne $cond.kind -and "$($cond.kind)" -ne '') -or
                                ($null -ne $cond.every -and "$($cond.every)" -ne '') -or
                                ($null -ne $cond.any -and "$($cond.any)" -ne '') -or
                                ($null -ne $cond.hwnd -and [int64]$cond.hwnd -ne 0) -or
                                ($null -ne $cond.title -and "$($cond.title)" -ne '') -or
                                ($null -ne $cond.control -and "$($cond.control)" -ne '') -or
                                ($null -ne $cond.path -and "$($cond.path)" -ne '') -or
                                ("$($cond.type)" -eq 'value' -and -not [string]::IsNullOrEmpty("$($cond.expected)"))
                if (-not $hasPredicate) {
                    throw "[BAD_REQUEST] step $stepIndex is a wait_for with no condition: give it a kind (window/control/value/text/every), or a hwnd/title/control/control_type selector, plus timeout_ms"
                }
            }
            'clipboard' {
                # The op enumeration Do-Clipboard enforces, checked here so the real run
                # and the rehearsal refuse the same step. (-contains is case-insensitive,
                # matching Do-Clipboard's -eq comparisons.)
                $clipOp = "$($candidate.op)"
                if ($clipOp -ne '' -and (@('get', 'set', 'clear') -notcontains $clipOp)) { throw "[BAD_REQUEST] step $stepIndex names an unknown clipboard op '$clipOp' (must be 'get', 'set' or 'clear')" }
                if ($clipOp -eq 'set' -and $null -eq $candidate.text) { throw "[BAD_REQUEST] step $stepIndex sets the clipboard without text" }
            }
            'screenshot' {
                if ([string]::IsNullOrWhiteSpace("$($candidate.path)") -and [string]::IsNullOrWhiteSpace($defaultPath)) {
                    throw "[BAD_REQUEST] step $stepIndex is a screenshot and neither it nor the call carries a path"
                }
            }
            default {
                $hasSelector = ($null -ne $candidate.ref -and "$($candidate.ref)" -ne '') -or
                               ($null -ne $candidate.automation_id -and "$($candidate.automation_id)" -ne '') -or
                               ($null -ne $candidate.name -and "$($candidate.name)" -ne '') -or
                               ($null -ne $candidate.control_type -and "$($candidate.control_type)" -ne '') -or
                               ($null -ne $candidate.class_name -and "$($candidate.class_name)" -ne '')
                if (-not $hasSelector) {
                    throw "[BAD_REQUEST] step $stepIndex ($candidateAction) needs at least one selector: ref, automation_id, name, control_type, or class_name"
                }
                if ($candidateAction -eq 'set_value' -and $null -eq $candidate.value) { throw "[BAD_REQUEST] step $stepIndex is a set_value without a value" }
                if (@('select_text', 'click_text', 'locate_text') -contains $candidateAction -and [string]::IsNullOrEmpty("$($candidate.text)")) {
                    throw "[BAD_REQUEST] step $stepIndex ($candidateAction) needs the text to locate"
                }
            }
        }
        $stepIndex += 1
    }

    if ($dryRun) {
        # NEW-P1-02 B2: rehearse instead of run. The deadline was published above
        # (Set-DeadlineAt), so the rehearsal's budget arithmetic is the real one;
        # Invoke-BatchDryRun clears it again before returning.
        return Invoke-BatchDryRun $Arg $steps $captureBase $deadlineMs $deadlineAtMs $guardWindows $baselineHwnd $expectedTransitions
    }

    foreach ($step in $steps) {
        $action = "$($step.action)".ToLowerInvariant()
        if ([string]::IsNullOrWhiteSpace($action)) { throw "step $index has no action" }
        try {
            # The budget, before the step and not only inside the waits (sec. 5.7). A step that
            # starts after the deadline is the failure this whole check exists for: the batch
            # reports how far it got, and the steps that did not run are named rather than
            # typed into a call whose time was already spent.
            $leftForStep = Get-BatchRemainingMs
            if ($leftForStep -le 0) {
                $outcome = 'deadline'
                $nextStep = [int]$index
                throw "[DEADLINE_EXHAUSTED] this call's deadline ran out before step $index ('$action'); the $($performed.Count) step(s) before it did run and nothing after it was started. Observe the result (computer_screenshot, computer_ui, or a `state` step in a new call) before deciding anything else, and give the next call a larger deadline_ms if this sequence needs longer."
            }
            # Cancellation is checked per step, not per call: the point of cancelling a
            # batch is that the *rest* of it does not happen. It is inside the try so
            # the caller still gets the steps that did run, plus the index it stopped at.
            Assert-NotCancelled "before step $index of $($steps.Count) ('$action')"
            if ($guardWindows -and ($FOREGROUND_STEP_ACTIONS -contains $action)) {
                $namesWindow = ($null -ne $step.into_hwnd) -or ($null -ne $step.from_frame -and "$($step.from_frame)" -ne '')
                if (-not $namesWindow) {
                    $live = Get-ForegroundInfo
                    if ([int64]$live.hwnd -eq 0) {
                        # Nothing holds the foreground: the step's own preflight will say so
                        # with a better message than "the window changed".
                    } elseif ($baselineHwnd -eq 0) {
                        $baselineHwnd = [int64]$live.hwnd
                    } elseif ([int64]$live.hwnd -ne $baselineHwnd) {
                        # A transition the caller declared is followed rather than stopped
                        # (B06) -- and what appears is identified and reported, because "the
                        # window changed" is not by itself a reason to keep typing into
                        # whatever is now in front. An undeclared one still stops the batch
                        # where it is.
                        $declared = Test-ExpectedTransition $expectedTransitions $live
                        if ($null -ne $declared) {
                            $transitions.Add([ordered]@{
                                atStep    = [int]$index
                                from      = [int64]$baselineHwnd
                                to        = [int64]$live.hwnd
                                title     = "$($live.title)"
                                process   = "$($live.process)"
                                matchedBy = "$($declared.matchedBy)"
                                note      = 'declared in expectedTransitions, so the batch continued into this window'
                            })
                            $baselineHwnd = [int64]$live.hwnd
                        } else {
                            $nowTitle = "$($live.title)"
                            if ($nowTitle -eq '') { $nowTitle = '(untitled)' }
                            $outcome = 'reobserve-required'
                            $nextStep = [int]$index
                            throw "the window in front changed during this batch: it was hwnd $baselineHwnd when the batch started and is hwnd $($live.hwnd) [$($live.process)] `"$nowTitle`" before step $index ('$action'). A dialog, a menu or a navigation appeared, so the remaining $($steps.Count - $index) step(s) would go to this window instead of the one you meant. Nothing after step $($index - 1) was run: observe again (computer_windows for the window list, computer_ui for the new window's controls), then continue from step $index -- pass expected_transitions to declare a window change this sequence is supposed to make, or stop_on_window_change: false to accept that the rest follows whatever is in front. (action_sent=false for this step; the steps listed as performed did happen)"
                        }
                    }
                }
            }
            switch ($action) {
                'click' {
                    $r = Do-Click @{ x = $step.x; y = $step.y; fromFrame = $step.from_frame; button = $step.button; clicks = $step.clicks; modifiers = $step.modifiers; preferA11y = $step.prefer_a11y; allowActivate = $step.allow_activate; verifyContent = $step.verify_content; allowWindows = $step.allow_windows }
                    $via = ''
                    if ("$($r.via)" -eq 'a11y') { $via = ' [a11y]' }
                    $performed.Add("click ($($r.x),$($r.y)) x$($r.clicks) $($r.button)$via")
                }
                'move' {
                    # A relative move (dx/dy) is its own branch, not a coordinate write: it
                    # names no point, so there is nothing to project, nothing to guard and no
                    # frame to check -- and it is the only form that works where the pointer
                    # is locked or recentred (8.txt sec. 9).
                    if ($null -ne $step.dx -or $null -ne $step.dy) {
                        $dx = 0
                        if ($null -ne $step.dx) { $dx = [int]$step.dx }
                        $dy = 0
                        if ($null -ne $step.dy) { $dy = [int]$step.dy }
                        $rel = Do-MouseMoveRelative $dx $dy
                        Set-WriteStamp -What 'move'
                        $performed.Add("move relative dx=$dx dy=$dy (observed $($rel.observedDelta.dx),$($rel.observedDelta.dy))")
                    } else {
                    # A move may be aimed with a frame's image pixels too, and then it is a
                    # coordinate write like any other: projected, checked against the window's
                    # identity and geometry, and put through the landing guard (A05) *before* the
                    # pointer moves. Without this the step took the image point as a desktop point
                    # -- silently, and with no guard at all, which is the one coordinate write the
                    # guard never saw. A hover lands on whatever is under the point just as a click
                    # does: hover menus, tooltips and drag targets all read it.
                    if (-not [string]::IsNullOrEmpty("$($step.from_frame)")) {
                        $resolved = Resolve-FramePoint ([string]$step.from_frame) ([int]$step.x) ([int]$step.y) ([ordered]@{ allowActivate = ($step.allow_activate -eq $true); verifyContent = $step.verify_content; allowWindows = $step.allow_windows })
                        if ($resolved.ok -ne $true) { throw "$($resolved.error)" }
                        $r = [ordered]@{
                            x     = [int]$resolved.x
                            y     = [int]$resolved.y
                            frame = (Get-FrameReceipt $resolved.frame ([int]$step.x) ([int]$step.y) ([int]$resolved.x) ([int]$resolved.y) ([int]$resolved.drift) "$($resolved.note)" $resolved.guard "$($resolved.mapping)" ([bool]$resolved.activated))
                        }
                    } else {
                        $r = [ordered]@{ x = [int]$step.x; y = [int]$step.y }
                    }
                    Do-MouseMove ([int]$r.x) ([int]$r.y)
                    $performed.Add("move ($($r.x),$($r.y))")
                    # Moving the pointer is a write: it changes what is under the cursor
                    # (hover, tooltip, focus), and this file already treats it as one
                    # everywhere else -- WRITE_STEP_ACTIONS includes it, and the evidence
                    # fingerprint is taken before it. Without a stamp here the other write
                    # bookkeeping disagreed with the evidence path about the same step.
                    Set-WriteStamp -What 'move'
                    }
                }
                'drag' {
                    # fromLast/continueFrom must reach Do-Drag: the pre-validation above
                    # blesses a continuation drag without from_x/from_y, so dropping the
                    # flags here would send a real drag from (0,0) instead of the handle.
                    $r = Do-Drag @{ fromX = $step.from_x; fromY = $step.from_y; toX = $step.to_x; toY = $step.to_y; path = $step.path; durationMs = $step.duration_ms; fromFrame = $step.from_frame; modifiers = $step.modifiers; allowActivate = $step.allow_activate; verifyContent = $step.verify_content; allowWindows = $step.allow_windows; fromLast = $step.fromLast; continueFrom = $step.continueFrom }
                    if ($null -ne $r['path']) {
                        $performed.Add("drag a $($r.path.points)-point path ($($r.path.samples) moves, $($r.path.durationMs) ms) ($($r.from.x),$($r.from.y))->($($r.to.x),$($r.to.y))")
                    } else {
                        $performed.Add("drag ($($r.from.x),$($r.from.y))->($($r.to.x),$($r.to.y))")
                    }
                }
                'scroll' {
                    $r = Do-Scroll @{ direction = $step.direction; clicks = $step.clicks; x = $step.x; y = $step.y; fromFrame = $step.from_frame; allowActivate = $step.allow_activate; verifyContent = $step.verify_content; allowWindows = $step.allow_windows }
                    $performed.Add("scroll $($r.direction) x$($r.clicks)")
                }
                'type' {
                    $r = Do-Type @{ text = $step.text; delayMs = $step.delay_ms; intoHwnd = $step.into_hwnd }
                    $performed.Add("type $($r.typed) char(s)")
                }
                'paste' {
                    $r = Do-Paste @{ text = $step.text; restore = $step.restore; requireRestore = $step.require_restore; intoHwnd = $step.into_hwnd; verify = $step.verify }
                    # The restore outcome is six-valued now (sec. 6), so the step line says which one
                    # happened instead of collapsing five of them into "could not be restored".
                    $restoreWord = switch ("$($r.restoreStatus)") {
                        'restored'                    { 'the previous clipboard content is back' }
                        'not_requested'               { 'the pasted text was left on the clipboard' }
                        'skipped_external_change'     { 'the clipboard was NOT restored: something else wrote to it after this paste' }
                        'unsupported_original_format' { 'the previous clipboard content could not be fully restored' }
                        'failed_busy'                 { 'the previous clipboard content could NOT be restored (it was held open)' }
                        'failed_other'                { 'the previous clipboard content could NOT be restored' }
                        default                       { "$($r.restoreStatus)" }
                    }
                    $verifiedWord = ''
                    if ($null -ne $r.pasteVerification) {
                        if ("$($r.pasteVerification.status)" -eq 'verified') { $verifiedWord = '; verified in the control' }
                        elseif ("$($r.pasteVerification.status)" -eq 'absent') { $verifiedWord = '; NOT verified: the text is not in the control it was read back from' }
                        else { $verifiedWord = '; the paste could not be verified' }
                    }
                    $performed.Add("paste $($r.pasted) char(s) ($restoreWord$verifiedWord)")
                }
                'key' {
                    $holdMs = 0
                    if ($null -ne $step.hold_seconds) { $holdMs = [int]([Math]::Min(10, [Math]::Max(0, [double]$step.hold_seconds)) * 1000) }
                    $r = Do-Key @{ keys = $step.keys; repeat = $step.repeat; holdMs = $holdMs; intoHwnd = $step.into_hwnd }
                    $performed.Add("key $($r.keys) x$($r.repeat)")
                }
                'focus' {
                    if ($null -eq $step.hwnd) { throw "a focus step needs hwnd" }
                    $r = Do-Focus @{ hwnd = $step.hwnd }
                    $performed.Add("focus hwnd=$($r.hwnd) '$($r.title)'")
                }
                'clipboard' {
                    $op = 'get'
                    if ($null -ne $step.op) { $op = "$($step.op)" }
                    $r = Do-Clipboard @{ op = $op; text = $step.text }
                    if ($op -eq 'get') {
                        $shown = $r.text
                        if ($shown.Length -gt 2000) { $shown = $shown.Substring(0, 2000) }
                        $performed.Add("clipboard get -> $($shown.Length) char(s): $shown")
                    } else {
                        $performed.Add("clipboard $op $($r.length) char(s)")
                    }
                }
                'wait' {
                    $seconds = [double]$step.seconds
                    if ($seconds -lt 0) { $seconds = 0 }
                    if ($seconds -gt 30) { $seconds = 30 }
                    $wanted = [int]($seconds * 1000)
                    # The step's duration is a request, not a licence to overrun the call's
                    # deadline: what is left of the batch budget is the ceiling (C04).
                    $left = Get-BatchRemainingMs
                    $spent = $wanted
                    if ($left -ne [int]::MaxValue -and $left -lt $wanted) { $spent = [int]$left }
                    if ($spent -gt 0) {
                        Wait-Cancellable $spent
                        # A wait is an observation boundary wherever it happens -- but only when
                        # time actually passed. A `wait: 0` step is not a boundary: it produces
                        # no new state, so the frame taken a moment ago is still the freshest
                        # thing this call has, and invalidating it would make the call pay for
                        # a second capture of a screen nobody looked away from.
                        [void](Advance-ObservationEpoch)
                    }
                    if ($spent -lt $wanted) {
                        $performed.Add("wait $([Math]::Round($spent / 1000.0, 2))s of the $([Math]::Round($seconds, 2))s asked for (this call's deadline is closer)")
                        $outcome = 'deadline-partial'
                        if ($nextStep -lt 0) { $nextStep = [int]$index }
                    } else {
                        $performed.Add("wait $([Math]::Round($seconds, 2))s")
                    }
                }
                'wait_for' {
                    # Waiting for a *condition* rather than for a duration. The worker
                    # polls, so the model does not have to: one call replaces the
                    # click / read / "not yet" / sleep / read again loop, and it returns
                    # as soon as the condition holds instead of at the end of a sleep
                    # chosen before anyone knew how fast the app would be.
                    $waitSpec = $step
                    if ($null -eq $waitSpec.condition) { $waitSpec = @{ condition = $step; timeout_ms = $step.timeout_ms } }
                    # The call's own deadline bounds this wait too (C04). A step that carries its
                    # own `condition` arrives as a JSON object, and a JSON object cannot have a
                    # property added to it: assigning `deadlineAtMs` on one threw "no such
                    # property" and the step failed instead of waiting (found by deadline-test,
                    # fixed here). The spec is rebuilt as something that can hold the deadline.
                    if ($deadlineAtMs -gt 0) {
                        if ($waitSpec -is [hashtable]) {
                            $waitSpec['deadlineAtMs'] = $deadlineAtMs
                        } else {
                            $waitSpec = @{
                                condition = (Get-ConditionField $waitSpec 'condition')
                                timeout_ms = (Get-ConditionField $waitSpec 'timeout_ms')
                                poll_ms = (Get-ConditionField $waitSpec 'poll_ms')
                                deadlineAtMs = $deadlineAtMs
                            }
                        }
                    }
                    $r = Wait-ForCondition $waitSpec
                    $line = "wait_for $($r.what) -> $(if ($r.satisfied) { 'satisfied' } else { 'not satisfied' }) after $($r.waitedMs) ms in $($r.polls) check(s)"
                    if (-not $r.satisfied) { $line = "$line; the condition was never true inside the budget" }
                    $performed.Add($line)
                    # The condition report is attached to the step log line, not sent as a
                    # failure: a wait that timed out leaves the caller with a real
                    # observation ("still nothing") that is worth acting on.
                    # `+=` grows a *fixed-size array*, and an array cannot be extended
                    # with the + operator unless both sides are collections.
                    $waitReports.Add($r)
                    if (-not $r.satisfied) {
                        # A condition that did not become true stops the steps that depend on
                        # it (C02). Carrying on was the old behaviour, and it is the shape of
                        # failure nobody notices: the click after a failed "wait for the
                        # dialog" goes into whatever window is there, and the batch reports
                        # success. `on_timeout: 'continue'` is the explicit way to ask for the
                        # old behaviour.
                        $onTimeout = 'stop'
                        if ("$($step.on_timeout)" -ne '') { $onTimeout = "$($step.on_timeout)".ToLowerInvariant() }
                        if ($onTimeout -eq 'continue') {
                            $performed.Add("continuing past the wait_for step because on_timeout is 'continue'")
                        } else {
                            $observedStatus = "$($r.status)"
                            $outcome = 'condition-timeout'
                            if ($observedStatus -eq 'unknown') { $outcome = 'condition-unobservable' }
                            $nextStep = [int]$index
                            $how = "the condition was not satisfied: $($r.what) -- $($r.observed)"
                            if ($observedStatus -eq 'unknown') {
                                $how = "the condition could not be observed at all: $($r.what) -- $($r.observed)"
                            }
                            throw "[CONDITION_TIMEOUT] step $index ('wait_for') stopped this batch: $how ($($r.polls) check(s) over $($r.waitedMs) ms of a $($r.timeoutMs) ms budget). Nothing after step $index was run -- the steps before it did run, and the steps after it were the ones that would have needed this condition to hold. Decide whether to wait longer (raise timeout_ms), look at the window yourself (computer_ui or computer_screenshot), or continue deliberately by putting on_timeout: 'continue' on this step. (action_sent=false for this step; the steps listed as performed did happen)"
                        }
                    }
                }
                'screenshot' {
                    Settle-Before-Capture
                    # One normalisation for every capture this batch takes (sec. 5.4): the step's
                    # own arguments win over the batch-level ones, and `regionSpace`/`clip`
                    # reach the capture now instead of being dropped between the host and the
                    # worker. The pacing arguments are the step's own where it asked for them,
                    # because the reason to wait is a property of *this* capture: the step
                    # that follows a step opening a slow dialog is the one that needs a
                    # budget, and the step that just wants the pixels should not pay for it.
                    $shotArgs = New-CaptureArgs $captureBase $step
                    if ([string]::IsNullOrWhiteSpace("$($shotArgs.path)")) { throw "a screenshot step needs a path" }
                    # A capture after the last write can stand in for the batch's "after"
                    # evidence reading instead of a second grab of the same rectangle.
                    if ($null -ne $evidenceRect -and $index -gt $lastWriteIndex) { $shotArgs.evidenceRect = $evidenceRect }
                    $shot = Do-Screenshot $shotArgs
                    if ($null -ne $shot.evidenceDigest -and "$($shot.evidenceDigest)" -ne '') { $evidenceDigest = "$($shot.evidenceDigest)" }
                    $stepCapture = Get-CaptureStampInfo
                    if ($null -ne $stepCapture) {
                        # Every screenshot step makes its frame the current candidate.
                        # Whether it may *be* the answer is decided at the end, against the
                        # write ordinal -- keeping only "fresh so far" frames here was a bug:
                        # a batch with no earlier write kept nothing, and then paid for a
                        # second capture of a screen it already had.
                        $usefulCapture = [ordered]@{
                            shot = $shot
                            capture = $stepCapture
                            # The *shape* of the request that produced this frame, kept whole
                            # so the trailing capture can be compared against it field by field
                            # (sec. 7.3). A frame may stand in for the trailing capture only if it
                            # is the same picture: another scale, surface, region or clip is
                            # another picture, even when the rectangle and the moment are the
                            # same (A06).
                            spec = $shotArgs
                            # Which step produced it, carried *with* the frame (sec. 5.6). The
                            # index used to be recorded once, for the first screenshot step,
                            # while the frame itself was replaced by every later one -- so a
                            # reply that returned the frame of step 5 said step 2.
                            stepIndex = [int]$index
                        }
                    }
                    $performed.Add("screenshot $($shot.width)x$($shot.height)@$($shot.scale)")
                }
                { $UIA_STEP_ACTIONS -contains $action } {
                    # One branch for every UI Automation step, taken from the same list
                    # the single-step tool and the host's schema use, so the three can
                    # no longer drift apart.
                    $r = Invoke-UiaStep $step
                    if ("$($r.canceled)" -eq 'True') { throw "$($r.error)" }
                    $performed.Add((Get-UiaStepLine $action $r))
                }
                default { throw "unknown step action '$action'; known actions: $($STEP_ACTIONS -join ', ')" }
            }
        } catch {
            $phrase = $_.Exception.Message
            $cancelled = $phrase.StartsWith('[CANCELED]', [System.StringComparison]::Ordinal)
            # Running out of budget is an outcome of its own, not a failed step: the step that
            # refused did so *because* the call was over, and the caller's next move is a new
            # call with a larger deadline (or an observation), not a fix to the arguments (sec. 5.7).
            $outOfTime = $phrase.StartsWith('[DEADLINE_EXHAUSTED]', [System.StringComparison]::Ordinal)
            # A step whose input only partly landed is its own outcome (sec. 6): some of it is in
            # the application, so it is neither "failed" (nothing happened) nor "completed".
            $partialSend = $phrase.StartsWith('[PARTIAL_INPUT]', [System.StringComparison]::Ordinal)
            $evidence = Complete-Evidence
            # A failed batch still returns the frame it has, but says which one it is: a
            # screenshot step that ran before the step that failed produced a real picture
            # of a real moment, and the caller has to be able to tell it from a frame of
            # the state after the failure (which nobody took).
            if ($wantedShot -and [string]::IsNullOrWhiteSpace($defaultPath) -and $Arg.screenshot -eq $true) { throw "a trailing screenshot needs a path" }
            if ($wantedShot -and $null -eq $shot -and $null -ne $usefulCapture) {
                $fresher = Test-CaptureReusable $usefulCapture.capture
                $shot = $usefulCapture.shot
                Set-PayloadField $shot 'stepIndex' ([int]$usefulCapture.stepIndex)
                Set-PayloadField $shot 'afterLastWrite' $fresher
                if (-not $fresher) {
                    Set-PayloadField $shot 'note' "this frame is from before the step that failed (step $($usefulCapture.stepIndex)), so it shows the state the batch started from"
                }
            } elseif ($wantedShot -and $null -ne $shot -and $null -eq $shot.afterLastWrite) {
                Set-PayloadField $shot 'afterLastWrite' $false
            }
            if ($cancelled) { $outcome = 'cancelled' }
            elseif ($outOfTime) { $outcome = 'deadline' }
            elseif ($partialSend) { $outcome = 'partial' }
            elseif ($outcome -eq 'ok') { $outcome = 'step-failed' }
            # The state of the step that stopped the batch, read off the evidence rather than
            # guessed: it ran out of budget before sending, it sent part of itself, it sent and
            # the outcome is unknown (the message says so), or it was refused before sending.
            $stepState = 'not-sent'
            if ($outOfTime) { $stepState = 'not-run' }
            elseif ($partialSend) { $stepState = 'partial' }
            elseif ($phrase -match 'action_sent=true') { $stepState = 'dispatched' }
            $progress = @(New-BatchProgress $steps $index $stepState)
            $failure = [ordered]@{
                performed = @($performed.ToArray())
                count     = $performed.Count
                failedAt  = $index
                error     = $phrase
                canceled  = $cancelled
                outOfBudget = $outOfTime
                partial     = $partialSend
                progress    = @($progress)
                partialSteps = @($progress | Where-Object { "$($_.state)" -eq 'partial' } | ForEach-Object { [int]$_.step })
                elapsedMs = [int]$stopwatch.ElapsedMilliseconds
                # ActionReceipt (B07): what was put into the desktop, what happened, and
                # where the sequence can be picked up again are three different facts, and
                # the reply used to leave two of them to be inferred.
                outcome     = "$outcome"
                action_sent = ($wroteSteps.Count -gt 0)
                wroteSteps  = @($wroteSteps.ToArray() | ForEach-Object { [int]$_ })
                shot      = $shot
                evidence  = $evidence
                state     = $null
                waits     = @($waitReports.ToArray())
            }
            if ($nextStep -ge 0) { $failure['nextStep'] = [int]$nextStep }
            # The deadline numbers belong to a failed call as much as to a successful one: this
            # is exactly the case ("it stopped on budget") they were added for (sec. 5.7).
            if ($deadlineMs -gt 0) {
                $over = [int64]$script:Clock.ElapsedMilliseconds - [int64]$deadlineAtMs
                $failure['deadlineMs'] = [int]$deadlineMs
                $failure['overDeadlineMs'] = [int]([Math]::Max(0, $over))
                $failure['deadlineMet'] = ($over -le 0)
            }
            if ($transitions.Count -gt 0) { $failure['transitions'] = @($transitions | ForEach-Object { $_ }) }
            return $failure
        }
        # A step that named its window has moved the batch on purpose, so the guard's
        # baseline follows it. Without this, "focus the dialog, then type" -- the correct
        # way to handle a window the batch itself raised -- would trip the guard.
        if ($WRITE_STEP_ACTIONS -contains $action) { $wroteSteps.Add([int]$index) }
        if ($guardWindows) {
            if ($null -ne $step.into_hwnd) { $baselineHwnd = [int64]$step.into_hwnd }
            elseif ($action -eq 'focus' -and $null -ne $step.hwnd) { $baselineHwnd = [int64]$step.hwnd }
            elseif (($UIA_STEP_ACTIONS -contains $action) -and $null -ne $step.hwnd) { $baselineHwnd = [int64]$step.hwnd }
        }
        # The write itself already stamped its ordinal inside the action that performed it,
        # which is why there is nothing to record here.
        $index += 1
    }

    # A condition the caller wants true before the batch is judged. It runs after the
    # steps and before any trailing capture or read, so what comes back is the state the
    # caller was waiting for -- which is the whole point of asking for it here rather
    # than spending another round trip to look, decide "not yet", and look again.
    if ($null -ne $Arg.waitFor) {
        Assert-NotCancelled 'before the batch-level condition wait'
        # Copied into a fresh table rather than mutated in place: the argument may be a
        # PSCustomObject straight off the JSON line, and the deadline has to be carried into
        # it so this wait is bounded by the same budget as the steps before it (C04).
        $batchWait = $Arg.waitFor
        $waitSpec = @{}
        if ($batchWait -is [System.Collections.IDictionary]) {
            foreach ($key in $batchWait.Keys) { $waitSpec[$key] = $batchWait[$key] }
        } else {
            foreach ($property in $batchWait.PSObject.Properties) { $waitSpec[$property.Name] = $property.Value }
        }
        if ($deadlineAtMs -gt 0) { $waitSpec['deadlineAtMs'] = $deadlineAtMs }
        $batchReport = Wait-ForCondition $waitSpec
        $waitReports.Add($batchReport)
        if (-not $batchReport.satisfied -and $outcome -eq 'ok') {
            $outcome = 'condition-timeout'
            if ("$($batchReport.status)" -eq 'unknown') { $outcome = 'condition-unobservable' }
        }
    }

    $shotReuse = ''
    $wantedShot = ($Arg.screenshot -eq $true)
    # Set when one of the trailing *observations* fails (the capture, the accessibility read):
    # it is attached to the reply rather than replacing it, because the steps already ran (sec. 5.2).
    $observation = $null
    # The trailing capture's request, built here by the same rules a step's capture uses
    # (sec. 5.4) -- and built unconditionally, so the comparison below is against exactly the
    # request the trailing capture would send.
    $trailingArgs = New-CaptureArgs $captureBase
    if ($wantedShot -and $null -ne $usefulCapture) {
        # A step already took the picture this call was asked for. Whether that frame *is*
        # the answer is an ordering question, and it is asked of the write ordinals *and* the
        # observation epoch (a frame from before a wait may not stand in for the state after
        # it): a batch that shot the screen at step 2 and clicked at step 5 has a frame from
        # before its own last write, and reporting it as the result is the one failure the
        # caller cannot see. No write and no wait after it means it is the answer, and the
        # trailing capture that used to be taken anyway is skipped.
        # The trailing capture's request, by the same rules as a step's (sec. 5.4): the comparison
        # below is against exactly the request the trailing capture would send.
        $sameRequest = Test-SameCaptureSpec $usefulCapture.spec $trailingArgs
        if ($sameRequest -and (Test-CaptureReusable $usefulCapture.capture)) {
            $shotReuse = 'step'
            $shot = $usefulCapture.shot
            Set-PayloadField $shot 'stepIndex' ([int]$usefulCapture.stepIndex)
            Set-PayloadField $shot 'afterLastWrite' $true
        } elseif ([string]::IsNullOrWhiteSpace($defaultPath)) {
            # Nothing to reuse and no path for a new frame: the step's frame is returned
            # rather than a capture that could not be written anyway.
            $shotReuse = 'step-stale'
            $shot = $usefulCapture.shot
            Set-PayloadField $shot 'afterLastWrite' $false
            Set-PayloadField $shot 'stepIndex' ([int]$usefulCapture.stepIndex)
            Set-PayloadField $shot 'note' 'the only capture this call took came before its last write, so this frame shows the state before the steps finished; pass screenshot: true with a save_path (or add a screenshot step) to get a frame of the state after them'
        } else {
            $shotReuse = 'retaken'
        }
    }
    # `step-stale` is a *decision*, not a reason to ask for a path: the frame it refers to is
    # the one already on disk, so a call without a save_path still has an answer to give.
    # Testing only `-ne 'step'` here made that state unreachable -- the branch above was
    # followed by the throw below, so the reply was always the refusal instead.
    if ($wantedShot -and $shotReuse -ne 'step' -and $shotReuse -ne 'step-stale') {
        if ([string]::IsNullOrWhiteSpace($defaultPath)) { throw "a trailing screenshot needs a path" }
        # The steps all ran, but the capture is still something the caller may not want
        # any more: a batch that takes two seconds to lay out is exactly when "stop" is
        # pressed, and a frame nobody asked for is real cost.
        Assert-NotCancelled 'before the trailing screenshot'
        Settle-Before-Capture
        # Every step is behind it, so it is always on the right side of the last write.
        if ($null -ne $evidenceRect) { $trailingArgs.evidenceRect = $evidenceRect }
        try {
            $shot = Do-Screenshot $trailingArgs
        } catch {
            # The capture is the trailing *observation*, not the call: a screen that refuses to
            # be read (a locked desktop, a surface with no usable rectangle) must not replace
            # the record of the steps that already ran (sec. 5.2). The failure is attached, and the
            # caller is told to take the picture itself.
            $shot = $null
            $shotReuse = ''
            $observation = [ordered]@{
                failed = $true
                what   = 'capture'
                error  = "$($_.Exception.Message)"
                note   = 'the steps in this call did run; it is the capture at the end that failed, so take it yourself with computer_screenshot and read the window again'
            }
        }
        if ($null -ne $shot) {
            if ($null -ne $shot.evidenceDigest -and "$($shot.evidenceDigest)" -ne '') { $evidenceDigest = "$($shot.evidenceDigest)" }
            # A window capture with a region is cropped inside the capture itself now (raw
            # pixels, one scale, one encode): the old path wrote the whole window, read it back
            # from disk, cropped it with coordinates from the wrong space and scaled it again.
            Set-PayloadField $shot 'afterLastWrite' $true
            if ($shotReuse -eq 'retaken') {
                Set-PayloadField $shot 'note' 'a screenshot step earlier in this batch had already produced a frame, but a write came after it, so this capture was taken to return the state after the last step rather than a picture of the state before it'
            }
        }
    }
    if ($null -ne $shot -and $null -eq $shot.afterLastWrite) {
        $fresh = $true
        $liveStamp = Get-CaptureStampInfo
        if ($null -ne $liveStamp) { $fresh = Test-CaptureAfterWrite $liveStamp }
        Set-PayloadField $shot 'afterLastWrite' $fresh
        if (-not $fresh) {
            Set-PayloadField $shot 'note' 'this frame was taken before the last write in this call, so it shows the state before the steps finished'
        }
    }

    $evidence = Complete-Evidence
    $state = $null
    if ($null -ne $Arg.state) {
        # The same call can end with an observation instead of (or as well as) a
        # picture: an accessibility read is far smaller than a frame and answers
        # "did my batch do what I meant" more precisely than pixels do.
        Assert-NotCancelled 'before the trailing accessibility read'
        $s = $Arg.state
        try {
            $state = Do-UiTree @{
                hwnd         = $s.hwnd
                filter       = $s.filter
                name         = $s.name
                controlType  = $s.control_type
                automationId = $s.automation_id
                patterns     = $s.patterns
                maxDepth     = $s.max_depth
                maxNodes     = $s.max_nodes
                prune        = $s.prune
                since        = $s.since
                settleMs     = $settleMs
                # The trailing observation takes the same text configuration as a standalone
                # read, so "put the form in, then show me what it says" stays one call.
                text         = $s.text
                textTarget   = $s.text_target
                maxTextChars = $s.max_text_chars
                maxSelected  = $s.max_selected
                # NEW-P1-03: the trailing read can carry the OCR block too; same
                # shorthand as the standalone read (absent = not asked for).
                ocr          = $s.ocr
            }
        } catch {
            # The observation is a *second* thing this call does, and its failure does not undo
            # the first (sec. 5.2): the steps ran, so their receipt is returned with the read's
            # failure attached rather than the whole reply being replaced by an error.
            $observation = [ordered]@{
                failed = $true
                what   = 'state'
                error  = "$($_.Exception.Message)"
                note   = 'the steps in this call did run; it is the read at the end that failed, so read that window again before deciding anything else'
            }
        }
    }

    # NOT $result: within a function, assigning an undeclared variable named `$result`
    # shadows the caller's `$result` that contains this function's return value, and the
    # command handler then returns an array of two things -- which the parent reports as
    # an unrelated concat error. (`$matches` was learned the same way in Find-UiaMatch.)
    $reply = [ordered]@{
        performed = @($performed.ToArray())
        count     = $performed.Count
        failedAt  = -1
        error     = ''
        canceled  = $false
        elapsedMs = [int]$stopwatch.ElapsedMilliseconds
        outcome    = "$outcome"
        action_sent = ($wroteSteps.Count -gt 0)
        wroteSteps = @($wroteSteps.ToArray() | ForEach-Object { [int]$_ })
        shot      = $shot
        evidence  = $evidence
        state     = $state
        progress  = @(New-BatchProgress $steps -1 '')
        partialSteps = @()
    }
    if ($null -ne $observation) { $reply['observation'] = $observation }
    if ($nextStep -ge 0) { $reply['nextStep'] = [int]$nextStep }
    # How much of the call's own deadline was left (or how far past it the call ran). The
    # numbers are measured, never clamped to the budget: a blocking system call inside this
    # worker cannot be interrupted from here, and reporting the budget instead of the real
    # elapsed time is how a timeout came to look like it fitted (sec. 5.7, item 6).
    if ($deadlineMs -gt 0) {
        $over = [int64]$script:Clock.ElapsedMilliseconds - [int64]$deadlineAtMs
        $reply['deadlineMs'] = [int]$deadlineMs
        $reply['overDeadlineMs'] = [int]([Math]::Max(0, $over))
        $reply['deadlineMet'] = ($over -le 0)
    }
    if ($transitions.Count -gt 0) { $reply['transitions'] = @($transitions | ForEach-Object { $_ }) }
    if ($waitReports.Count -gt 0) { $reply['waits'] = @($waitReports | ForEach-Object { $_ }) }
    if ($shotReuse -ne '') {
        $captureUsed = [ordered]@{
            from           = "$shotReuse"
            stepIndex      = [int]$frameStepIndex
            afterLastWrite = $true
        }
        if ($null -ne $shot -and $null -ne $shot.afterLastWrite) { $captureUsed['afterLastWrite'] = [bool]$shot.afterLastWrite }
        if ($null -ne $shot -and $null -ne $shot.stepIndex) { $captureUsed['stepIndex'] = [int]$shot.stepIndex }
        $captureUsed['note'] = switch ($shotReuse) {
            'step'        { 'returned the frame a screenshot step in this batch already took, because it is newer than the last write; no second capture was taken' }
            'step-stale'  { 'returned the frame a screenshot step took, although it predates the last write, because this call has no path to write a new one to' }
            'retaken'     { 'a screenshot step earlier in the batch had already taken a frame, but a write came after it, so a fresh capture was taken to return the state after the last step' }
            default       { '' }
        }
        $reply['captureUsed'] = $captureUsed
    }
    if ($env:DSH_COMPUTER_USE_DEBUG -eq '1') {
        # Off by default. When a capture-provenance question is being chased, this is what
        # says whether the frame was reused or retaken and which write ordinals decided it.
        $facts = [ordered]@{
            writeSeq      = [int64]$script:WriteSeq
            shotReuse     = "$shotReuse"
            shotStepIndex = [int]$frameStepIndex
            afterLastWrite = $(if ($null -ne $shot -and $null -ne $shot.afterLastWrite) { "$($shot.afterLastWrite)" } else { 'n/a' })
        }
        if ($null -ne $shot) {
            $live = Get-CaptureStampInfo
            if ($null -ne $live) {
                $facts.shotAgeMs = [int]$live.ageMs
                $facts.shotWriteSeq = [int64]$live.writeSeq
            }
        }
        $facts.writeStamp = Get-WriteStampInfo
        if ($null -ne $usefulCapture -and $null -ne $usefulCapture.capture) {
            $facts.stepCaptureSeq = [int]$usefulCapture.capture.seq
            $facts.stepCaptureWriteSeq = [int64]$usefulCapture.capture.writeSeq
            $facts.stepCaptureAtMs = [int64]$usefulCapture.capture.atMs
        }
        $reply['debug'] = $facts
    }
    # The batch is over: the next request must not inherit this call's deadline. (The main loop
    # clears it as well, so a throw cannot leave it behind either way.)
    Clear-Deadline
    return $reply
}

