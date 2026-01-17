export function formatTrack(track) {
  if (!track) return "-";
  const title = track.title || "Unknown";
  const artist = track.artist || "Unknown";
  return `${title} - ${artist}`;
}

export function formatTime(totalSeconds) {
  if (typeof totalSeconds !== "number" || Number.isNaN(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const seconds = Math.floor(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
