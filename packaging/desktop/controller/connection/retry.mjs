export function retryDelay({ healthInterval, failureThreshold, maxBackoff }, failures) {
    if (failures < failureThreshold) {
        return healthInterval * 1000;
    }

    return (
        Math.min(maxBackoff, healthInterval * 2 ** Math.min(6, failures - failureThreshold)) *
        (750 + Math.random() * 250)
    );
}
