// The app-level question and the export-size prompt.
//
// One dialog at a time, raised from anywhere: the header's preset picker, a
// shared link arriving, a scene file dropped on the viewport, the exporters.
// A store of its own rather than App state because those callers are hooks and
// components App only composes, and threading a setter through each of them is
// what kept them all inside App. See AppDialogs for where both are drawn.

import { createElement, type ReactNode } from 'react';
import { create } from 'zustand';

export interface DialogSpec {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  tone?: 'blue' | 'red' | 'amber';
  onConfirm: () => void;
  /** Defaults to closing the dialog. */
  onCancel?: () => void;
}

/** Asks how big the longest part should come out, in mm, before an export. */
export interface ScalePrompt {
  title: string;
  value: string;
  onConfirm: (targetMm: number) => void;
}

interface DialogState {
  dialog: DialogSpec | null;
  openDialog: (dialog: DialogSpec) => void;
  closeDialog: () => void;
  /** A one-button notice: something went wrong, or there was nothing to do. */
  showNotice: (title: string, message: string, tone?: 'blue' | 'red' | 'amber') => void;
  scalePrompt: ScalePrompt | null;
  promptScale: (prompt: ScalePrompt) => void;
  closeScalePrompt: () => void;
}

export const useDialogs = create<DialogState>((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  showNotice: (title, message, tone = 'amber') => set({
    dialog: {
      title,
      body: createElement('p', null, message),
      confirmLabel: 'OK',
      hideCancel: true,
      tone,
      onConfirm: () => set({ dialog: null }),
    },
  }),
  scalePrompt: null,
  promptScale: (scalePrompt) => set({ scalePrompt }),
  closeScalePrompt: () => set({ scalePrompt: null }),
}));
