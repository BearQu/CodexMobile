export function activityCardShouldOpen({ running, hasProcess, latestActivity = false }) {
  return Boolean(hasProcess && (running || latestActivity));
}
