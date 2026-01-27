# Signal K AIS Processing Plugin:

## About
This plugin ingests Signal K AIS deltas, builds and maintains target tracks, applies state governance rules to those tracks, and streams current targets. It normalizes identity by context/MMSI, maintains trails, and applies class‑specific thresholds to confirm, mark lost, and remove targets over time using configurable plugin parameters.

## AIS Statemanagement
These rules define how AIS targets are created, updated, confirmed, marked lost, and removed, so consumers displays consistent, timely, and reliable targets.

### Sources (input scope)
Subscribes to all delta of with the following context to determine which entities/updates are tracked:
- vessels
- ATONS
- basestations
- SAR
- Aircraft

### Track identity & indexing (stable identity)
Context (atons.urn:mrn:imo:mmsi:*) is the AIS target registry's primary key. One track per AIS context. The context is used to funnel all delta updates onto one object. MMSI is indexed when present to unify identity and detect conflicts (such as MMSI reuse issues). Only MMSI‑backed tracks are published to consumer.

Using context as the primary key has the benefit of being able to pre populate tracks with data before knowing the MMSI. NOTE: We could extract the MMSI from the context string straight away/before we get the MMSI delta. This would speed up AIS tracks publishing (we need position and cog minimum), although the tracks would posses little information at that point.

### Position report rules (message quality)
msgCount increments only if position timestamps differ by >500 ms; each valid report updates lastPositionAt and appends to trail (cap 120).

### State thresholds by class (reliability tuning)
Class A confirms quickly and times out quickly; Class B confirms slower and times out slower.

### State machine (status consistency)
MMSI conflict → force unconfirmed. Otherwise confirm if enough reports within confirmMaxAge, mark lost after lostAfter, else unconfirmed.

### Removal (cleanup)
Remove tracks older than removeAfter and clean indexes.

### Timing & publication (ressource consumption)
Status evaluation runs every 1s; target list emission is throttled to 250 ms.

## Parameters

### State Management 
``` typescript
// AIS processing defaults
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

### Context keys
``` typescript
const AIS_CONTEXT_PREFIXES = [
  'atons.urn:mrn:imo:mmsi:',
  'shore.basestations.urn:mrn:imo:mmsi:',
  'vessels.urn:mrn:imo:mmsi:',
  'sar.urn:mrn:imo:mmsi:',
  'aircraft.urn:mrn:imo:mmsi:'
];
```

## WebSocket Streaming for AIS Track Map
Use WebSocket protocol to stream AIS track data to remote clients using an initial snapshot followed by incremental deltas.

### Connection & Session
The server MUST open a WebSocket endpoint for AIS streaming.
On connect, the server MUST assign a monotonically increasing seq baseline.

### Snapshot
The server MUST send a full snapshot of all current tracks immediately after connection.
The snapshot MUST include a seq and a server timestamp.

### Delta Stream
After the snapshot, the server MUST stream deltas as add, update, or remove.
Each delta MUST include:
- seq (monotonic sequence number)
- ts (server timestamp)
- id (track identifier)
- op (add|update|remove)
- fields (changed fields for add/update)

### Ordering & Consistency
- The server MUST increment seq for every delta message.
- Clients MUST apply deltas in ascending seq order.
- If a client detects a gap in seq, it MUST request a re‑sync (new snapshot).

### Throttling & Batching
- The server SHOULD batch updates within a configurable window (e.g., 100–250 ms).
- A batch MUST preserve ordering and include a seq range (fromSeq, toSeq).
- Throttling MUST NOT drop state; it may delay delivery only.

### Security
Anyone can query the pluging - no security
