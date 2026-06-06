import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/global.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('renderer: #root not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
