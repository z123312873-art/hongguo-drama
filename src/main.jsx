import React from 'react';
import ReactDOM from 'react-dom/client';
import './scriptRender.js';
import { initializeScript } from './scriptPreference.js';
import { bindUiScale } from './uiScale.mjs';
import { initializeFontScale } from './fontScale.mjs';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';

initializeScript();
bindUiScale();
initializeFontScale();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
