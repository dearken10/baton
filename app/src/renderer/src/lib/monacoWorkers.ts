/**
 * Tell Monaco where to find its web workers. Vite resolves the
 * `?worker` query and bundles each worker as a separate chunk.
 *
 * Each label corresponds to a language service worker. Falling back
 * to the generic editor.worker for unknown labels keeps things alive
 * even if Monaco adds a new language id we don't case on yet.
 *
 * Important: this file must be imported BEFORE @monaco-editor/react's
 * loader.config({ monaco }) actually mounts the editor (we do that
 * inside EditorPane.tsx). Side-effect import at app boot is fine too.
 */

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

interface MonacoEnvironment {
  getWorker(workerId: string, label: string): Worker;
}

(self as unknown as { MonacoEnvironment: MonacoEnvironment }).MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json': return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less': return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor': return new htmlWorker();
      case 'typescript':
      case 'javascript': return new tsWorker();
      default: return new editorWorker();
    }
  },
};
