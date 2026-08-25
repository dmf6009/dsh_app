import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { AppProvider } from './store/app-store';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root container missing');

createRoot(container).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>
);
