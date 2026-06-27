import { useEffect } from 'react';

type Task = (isActive: () => boolean) => void | Promise<void>;

export function usePollingTask(task: Task, intervalMs: number, deps: readonly unknown[]) {
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    const run = () => {
      void task(isActive);
    };

    run();
    const timer = window.setInterval(run, intervalMs);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, deps);
}
