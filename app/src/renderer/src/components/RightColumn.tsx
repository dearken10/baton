import { useState } from 'react';

type Tab = 'files' | 'git';

export function RightColumn(): JSX.Element {
  const [tab, setTab] = useState<Tab>('files');
  return (
    <aside className="col col-right">
      <div className="right-tabs">
        <button
          className={`right-tab ${tab === 'files' ? 'active' : ''}`}
          onClick={() => setTab('files')}
        >
          📁 Files
        </button>
        <button
          className={`right-tab ${tab === 'git' ? 'active' : ''}`}
          onClick={() => setTab('git')}
        >
          ⎇ Git
        </button>
      </div>
      <div className="panel">
        <div className="empty">
          <p>{tab === 'files' ? 'File tree lands in W4.' : 'Diff view lands in W4.'}</p>
        </div>
      </div>
    </aside>
  );
}
