# Signal K AIS Status Plugin:

## About
This plugin evaluates AIS target reporting continuity and maintains a per-target tracking state using class-specific timing thresholds. It publishes target tracking ***(metadata or path value???)*** to Signal K, enabling consuming applications to assess target validity, reliability, and reporting continuity.

## AIS Target State Management
The plugin applies standardized timing and continuity rules to manage AIS targets throughout their tracking lifecycle. Targets are created on first reception, transition to a confirmed tracking state after sufficient report continuity, and are marked as lost when expected reports are no longer received. The resulting tracking state is continuously updated and published for use by downstream consumers.

### Sources (input scope)
Subscribes to all delta of with the following context to determine which entities/updates are tracked:
- vessels
- AtoNs
- basestations
- SAR
- aircraft

### target identity & indexing (stable identity)
Context (atons.urn:mrn:imo:mmsi:*) is the plugin's AIS target registry primary key. One item per AIS context. The context is used to funnel all delta updates onto one map object for fast computation. MMSI is indexed when present to unify identity and detect conflicts (such as MMSI reuse issues).

Using context as the primary key has the benefit of being able to pre populate tracks with data before receiving the MMSI delta.

NOTE for discussion: We could extract the MMSI from the context string straight away/before we get the MMSI delta. This would speed up AIS tracks publishing (we need position and cog minimum), although the tracks would posses little information at that point.

### Position report rules (message quality)
msgCount increments only if position timestamps differ by >500 ms; each valid report updates lastPositionAt.

### State thresholds by class (reliability tuning)
Class A confirms quickly and times out quickly; Class B confirms slower and times out slower.

### State machine (status consistency)
MMSI conflict or not enough message received -> force unconfirmed state. Otherwise confirm if enough reports within threshold, mark lost after a periode no position is received, mark remove after a longer period without position..

### Removal (cleanup)
It's up to the client to determine who it reacts to target state remove.

### Timing & publication (ressource consumption)
Status evaluation runs at an interval short enough to accomodate the lowest `confirmMaxAge` value.

## State Management parameters

### Device Class Processing Definition
``` typescript
const AIS_DEFAULTS = {
  classA: {
    confirmAfterMsgs: 2,
    confirmMaxAge: 30,      // s
    lostAfter: 60,          // s
    removeAfter: 180,       // s
    interpHz: 1
  },
  classB: {
    confirmAfterMsgs: 3,
    confirmMaxAge: 90,      // s
    lostAfter: 180,         // s
    removeAfter: 600,       // s
    interpHz: 0.5
  }
}
```

## State Management lifecycle

**Trigger:** `<context>.navigation.position` received
| Condition | Action |
|---        |---     |
| `msgCount` < `confirmAfterMsgs` | `status` = **'unconfirmed'** <br>`msgCount` -> increment <br>`lastposition` = `Date.now()` |
| `msgCount` >= `confirmAfterMsgs` | `status` = **'confirmed'** <br>`msgCount` -> unchanged <br>`lastposition` = `Date.now()`

**Trigger:** Status Interval Timer Event
| Condition | Action |
|---        |---     |
| `Date.now() - lastPosition` > `confirmMaxAge` | `status` = **'stale'** <br>`msgCount` -> ?? <br>`lastposition` -> unchanged |
| `Date.now() - lastPosition` > `lostAfter` | `status` = **'lost'** <br>`msgCount` = 0 <br>`lastposition` -> unchanged |
| `Date.now() - lastPosition` > `removeAfter` | `status` = **'remove'** <br>`msgCount` = 0 <br>`lastposition` -> unchanged |

### Target Selection
``` typescript
const AIS_CONTEXT_PREFIXES = [
  'atons.urn:mrn:imo:mmsi:',
  'shore.basestations.urn:mrn:imo:mmsi:',
  'vessels.urn:mrn:imo:mmsi:',
  'sar.urn:mrn:imo:mmsi:',
  'aircraft.urn:mrn:imo:mmsi:'
];
```

### State Publishing
