import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectPage } from './ConnectPage';
import './index.css';

createRoot(document.getElementById('root')!).render(<StrictMode><ConnectPage /></StrictMode>);
