import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
window.addEventListener("popstate", notify);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  notify();
  window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function Link({
  to,
  children,
  className,
  exact = false,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  exact?: boolean;
}) {
  const path = usePath();
  const active = exact ? path === to : path === to || path.startsWith(`${to}/`);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} aria-current={active ? "page" : undefined} onClick={onClick}>
      {children}
    </a>
  );
}
