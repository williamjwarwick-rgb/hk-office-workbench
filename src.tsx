import React from 'react';
import { createRoot } from 'react-dom/client';
import Workbench from './app/components/Workbench';
import './app/globals.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><Workbench /></React.StrictMode>);
