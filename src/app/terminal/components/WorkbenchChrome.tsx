'use client';

import React, { createContext, useContext } from 'react';

/**
 * What the Terminal's layout puts in the workbench's own tab strip when the
 * workbench fills the window (no header bar): the Terminal's actions
 * (members, linked ERPs, …) and the link to its ERP.
 */
export const WorkbenchChrome = createContext<React.ReactNode>(null);

export const useWorkbenchChrome = () => useContext(WorkbenchChrome);
