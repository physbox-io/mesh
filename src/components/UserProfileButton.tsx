import React, { useCallback, useEffect, useReducer, useState } from 'react';
import { AccountMenu, useAccountSession, type AccountSignIn } from '@physbox-io/ui';
import { getStoredUser, getStoredAuthToken, clearStoredAuth, fetchCurrentUser } from '../utils/apiClient';
import { signInWithGooglePopup, disableGoogleAutoSelect } from '../utils/googleAuth';
import { pullCloudState } from '../utils/cloudSync';
import { loadPrinter } from '../utils/printerSettings';
import { useStore } from '../store/useStore';
import { webSerialManager } from '../utils/webSerialManager';
import { RemoteMachiningModal } from './RemoteMachiningModal';
import { JobHistoryModal } from './JobHistoryModal';
import { CloudSaveStatus } from './CloudSaveStatus';
import { GuestListModal } from './GuestListModal';

// eslint-disable-next-line react-refresh/only-export-components
export { SIGN_IN_REQUESTED_EVENT, SIGNED_IN_EVENT } from '@physbox-io/ui';

const AVATAR_KEY = 'physbox_user_avatar';

function readAvatar(): string | null {
  try {
    return localStorage.getItem(AVATAR_KEY);
  } catch {
    return null;
  }
}

async function pullAccount() {
  const { parameters, presets } = await pullCloudState();
  // The machine state holds the spindle override already applied, so a
  // value just restored from the account has to be pushed into it.
  webSerialManager.reapplySpindleOverride();
  // And the printer restored from the account, without sending it straight back.
  useStore.setState({ printer: loadPrinter() });
  return { parameters, items: presets.received + presets.sent };
}

/*
 * This document is cross-origin isolated, so a popup it opens cannot talk back
 * to it: Google's own button would give a blank window. The exchange happens
 * on public/signin.html, which leaves the shared session behind.
 */
const SIGN_IN: AccountSignIn = {
  kind: 'popup',
  start: async () => {
    await signInWithGooglePopup();
    if (!getStoredUser()) throw new Error('Sign in did not complete.');
  },
};

export const UserProfileButton: React.FC = () => {
  const { user, sync, refresh } = useAccountSession({
    storedUser: getStoredUser,
    fetchUser: fetchCurrentUser,
    pull: pullAccount,
    workNoun: 'scenes',
  });
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  /**
   * The avatar the sign-in window downloaded, as a data URI. An <img> pointing
   * at googleusercontent is refused by COEP on this page; a data URI is not.
   */
  const avatarData = user ? readAvatar() : null;
  const [, rereadAvatar] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AVATAR_KEY || event.key === 'physbox_auth_handoff') rereadAvatar();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Signed out in another app: the cached face must not greet the next account.
  useEffect(() => {
    if (user || getStoredAuthToken()) return;
    try {
      localStorage.removeItem(AVATAR_KEY);
    } catch {
      // Nothing cached to leak.
    }
  }, [user]);

  const handleSignedIn = useCallback(
    async (reason: string | null) => {
      // The guest-list window says access comes in batches, which is wrong for
      // somebody sent here to do something: that thing is open to them now.
      if (!reason && localStorage.getItem('physbox_auth_is_admin') !== '1') setShowGuestModal(true);
      await refresh();
    },
    [refresh]
  );

  const handleSignOut = useCallback(() => {
    clearStoredAuth();
    // Otherwise Google can hand the same account straight back on the next
    // visit, and signing out looks like it did nothing.
    disableGoogleAutoSelect();
    void refresh();
  }, [refresh]);

  return (
    <AccountMenu
      user={user}
      accent="cyan"
      workNoun="scenes"
      avatarDataUri={avatarData}
      sync={sync}
      signIn={SIGN_IN}
      onSignedIn={handleSignedIn}
      onSignOut={handleSignOut}
      onOpenRemote={() => setShowRemoteModal(true)}
      onOpenHistory={() => setShowHistoryModal(true)}
      onOpenGuestList={() => setShowGuestModal(true)}
    >
      {showRemoteModal && (
        <RemoteMachiningModal isOpen={showRemoteModal} onClose={() => setShowRemoteModal(false)} />
      )}
      {showHistoryModal && (
        <JobHistoryModal isOpen={showHistoryModal} onClose={() => setShowHistoryModal(false)} />
      )}
      {/* Always on screen, so it hosts the auto-save status, which portals itself into a corner. */}
      <CloudSaveStatus />
      {showGuestModal && (
        <GuestListModal
          isOpen={showGuestModal}
          onClose={() => setShowGuestModal(false)}
          userEmail={user?.email || ''}
        />
      )}
    </AccountMenu>
  );
};
