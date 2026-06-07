import { useMemo, useState } from 'react';

/**
 * Collapsible JSON tree view (PRD F6.2). Parses once per `source`
 * change; root + first level start expanded so the file is useful
 * immediately. Pure presentation — there's no editing here; the
 * Source toggle on the editor head sends the user back to Monaco
 * when they want to change something.
 */
interface Props {
  source: string;
}

export function JsonTreeView({ source }: Props): JSX.Element {
  const parsed = useMemo(() => {
    try { return { value: JSON.parse(source) as unknown, error: null }; }
    catch (err) {
      return { value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [source]);

  if (parsed.error) {
    return (
      <div className="json-tree">
        <div className="json-error">
          <div className="json-error-title">Invalid JSON</div>
          <pre className="json-error-body">{parsed.error}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="json-tree">
      <Node value={parsed.value} keyName={null} depth={0} defaultOpen />
    </div>
  );
}

interface NodeProps {
  value: unknown;
  /** Property name when this node is a child of an object, else null. */
  keyName: string | null;
  depth: number;
  /** Object/array nodes start expanded if true. */
  defaultOpen?: boolean;
}

function Node({ value, keyName, depth, defaultOpen }: NodeProps): JSX.Element {
  // Root + first level start expanded. Beyond that, collapse for
  // readability on large files.
  const initiallyOpen = defaultOpen ?? depth < 1;
  const [open, setOpen] = useState(initiallyOpen);

  const prefix = keyName != null ? (
    <span className="json-key">"{keyName}"<span className="json-colon">: </span></span>
  ) : null;

  if (value === null) {
    return <Row depth={depth}>{prefix}<span className="json-null">null</span></Row>;
  }
  if (typeof value === 'string') {
    return <Row depth={depth}>{prefix}<span className="json-string">"{escape(value)}"</span></Row>;
  }
  if (typeof value === 'number') {
    return <Row depth={depth}>{prefix}<span className="json-number">{String(value)}</span></Row>;
  }
  if (typeof value === 'boolean') {
    return <Row depth={depth}>{prefix}<span className="json-boolean">{String(value)}</span></Row>;
  }

  if (Array.isArray(value)) {
    const length = value.length;
    return (
      <>
        <Row depth={depth} clickable onClick={() => setOpen((v) => !v)}>
          <span className="json-caret">{open ? '▾' : '▸'}</span>
          {prefix}
          <span className="json-bracket">[</span>
          {open ? null : <><span className="json-summary"> {length} item{length === 1 ? '' : 's'} </span><span className="json-bracket">]</span></>}
        </Row>
        {open ? (
          <>
            {value.map((v, i) => (
              <Node
                key={i}
                value={v}
                keyName={String(i)}
                depth={depth + 1}
              />
            ))}
            <Row depth={depth}><span className="json-bracket">]</span></Row>
          </>
        ) : null}
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const length = entries.length;
    return (
      <>
        <Row depth={depth} clickable onClick={() => setOpen((v) => !v)}>
          <span className="json-caret">{open ? '▾' : '▸'}</span>
          {prefix}
          <span className="json-bracket">{'{'}</span>
          {open ? null : <><span className="json-summary"> {length} key{length === 1 ? '' : 's'} </span><span className="json-bracket">{'}'}</span></>}
        </Row>
        {open ? (
          <>
            {entries.map(([k, v]) => (
              <Node key={k} value={v} keyName={k} depth={depth + 1} />
            ))}
            <Row depth={depth}><span className="json-bracket">{'}'}</span></Row>
          </>
        ) : null}
      </>
    );
  }

  // Shouldn't happen with valid JSON, but render something useful.
  return <Row depth={depth}>{prefix}<span className="json-string">{String(value)}</span></Row>;
}

interface RowProps {
  depth: number;
  children: React.ReactNode;
  clickable?: boolean;
  onClick?: () => void;
}

function Row({ depth, children, clickable, onClick }: RowProps): JSX.Element {
  const style = { paddingLeft: 8 + depth * 14 };
  return (
    <div
      className={`json-row${clickable ? ' clickable' : ''}`}
      style={style}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
    >
      {children}
    </div>
  );
}

/** Tiny string escape for display. We only handle the two cases that
 *  would make the rendered tree confusing — newlines and quotes —
 *  since JSON.parse has already validated the input. */
function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
