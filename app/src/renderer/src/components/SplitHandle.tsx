import { useRef } from 'react';

/**
 * Thin vertical drag handle between two flex columns.
 *
 * Reports deltaX (in pixels) to the parent on every mousemove during
 * a drag. The parent decides what to do with it — typically clamp +
 * apply to a column width.
 */
interface Props {
  onResize: (deltaX: number) => void;
  /** Optional aria label for screen readers. */
  ariaLabel?: string;
}

export function SplitHandle({ onResize, ariaLabel }: Props): JSX.Element {
  const lastXRef = useRef<number | null>(null);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    lastXRef.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent): void => {
      if (lastXRef.current == null) return;
      const delta = ev.clientX - lastXRef.current;
      lastXRef.current = ev.clientX;
      if (delta !== 0) onResize(delta);
    };
    const onUp = (): void => {
      lastXRef.current = null;
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
      className="split-handle"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel ?? 'Resize column'}
    />
  );
}
