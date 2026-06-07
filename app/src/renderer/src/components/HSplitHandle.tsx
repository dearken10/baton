import { useRef } from 'react';

/**
 * Horizontal split handle — sits between two stacked flex zones and
 * reports deltaY (px) to the parent on every mousemove during a drag.
 * The parent converts that into a height percentage and applies it.
 *
 * Mirror of the vertical SplitHandle used between left/middle/right
 * columns. Kept as a separate component so the cursor + aria-orient
 * are correct.
 */
interface Props {
  onResize: (deltaY: number) => void;
  ariaLabel?: string;
}

export function HSplitHandle({ onResize, ariaLabel }: Props): JSX.Element {
  const lastYRef = useRef<number | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    lastYRef.current = e.clientY;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent): void => {
      if (lastYRef.current == null) return;
      const delta = ev.clientY - lastYRef.current;
      lastYRef.current = ev.clientY;
      if (delta !== 0) onResize(delta);
    };
    const onUp = (): void => {
      lastYRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className="h-split-handle"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel ?? 'Resize editor / terminal split'}
    />
  );
}
