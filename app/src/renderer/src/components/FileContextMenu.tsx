import { useEffect, useRef } from 'react';

interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Tiny absolute-positioned popup used for right-click on file rows.
 *  Closes on outside-click, Escape, scroll, or any item click.
 *  Returns null with no items so a right-click on a file we have no
 *  actions for doesn't pop an empty box. */
export function FileContextMenu({ x, y, items, onClose }: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (items.length === 0) {
      onClose();
      return;
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onScroll = (): void => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [items.length, onClose]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ position: 'fixed', left: x, top: y, zIndex: 1000 }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className="ctx-menu-item"
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
