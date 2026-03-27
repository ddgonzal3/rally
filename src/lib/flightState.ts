/** Tracks which flight pod was last clicked — set by FlightPod, read by store actions. */
export let lastFocusedFlightPodId: string | null = null;

export function setLastFocusedFlightPodId(id: string | null) {
  lastFocusedFlightPodId = id;
}
