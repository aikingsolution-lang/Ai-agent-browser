import React, { useState, useEffect } from 'react';
import { cloudApiSettingsStore, type CloudApiSettingsConfig, type TeamMember } from '@extension/storage';
import {
  FiUsers,
  FiUserPlus,
  FiShield,
  FiCopy,
  FiCheck,
  FiTrash2,
  FiKey,
  FiMail,
  FiUserCheck,
  FiClock,
} from 'react-icons/fi';

interface TeamManagementProps {
  isDarkMode: boolean;
}

export const TeamManagement: React.FC<TeamManagementProps> = ({ isDarkMode }) => {
  const [settings, setSettings] = useState<CloudApiSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);

  // Invite Form State
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [isInviting, setIsInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(false);

  // License Key State
  const [showLicenseKey, setShowLicenseKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [inputLicenseKey, setInputLicenseKey] = useState('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await cloudApiSettingsStore.getSettings();
        setSettings(currentSettings);
      } catch (error) {
        console.error('Failed to load team settings:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
    const unsubscribe = cloudApiSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleInviteMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;

    setIsInviting(true);
    try {
      await cloudApiSettingsStore.inviteTeamMember(inviteEmail.trim(), inviteRole);
      setInviteEmail('');
      setInviteSuccess(true);
      setTimeout(() => setInviteSuccess(false), 3000);
    } catch (error) {
      console.error('Failed to invite team member:', error);
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      await cloudApiSettingsStore.removeTeamMember(memberId);
    } catch (error) {
      console.error('Failed to remove team member:', error);
    }
  };

  const handleCopyLicenseKey = () => {
    if (!settings?.team.licenseKey) return;
    navigator.clipboard.writeText(settings.team.licenseKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div
          className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
          <h2 className={`mb-4 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            Team Seat Management
          </h2>
          <div className="animate-pulse space-y-4">
            <div className={`h-12 rounded ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'}`}></div>
            <div className={`h-24 rounded ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'}`}></div>
          </div>
        </div>
      </section>
    );
  }

  if (!settings) return null;

  const members = settings.team.members || [];
  const maxSeats = settings.team.maxSeats || 10;
  const allocatedSeats = members.length;
  const seatPercent = Math.min(100, Math.round((allocatedSeats / maxSeats) * 100));

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className={`text-xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
              Team & Enterprise Seat Management
            </h2>
            <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Manage team members, allocate seat licenses, and share enterprise LLM API capacity.
            </p>
          </div>
          <div className="flex items-center space-x-2 rounded-full bg-indigo-500/10 px-3.5 py-1 text-xs font-semibold text-indigo-400">
            <FiUsers className="h-4 w-4" />
            <span>{settings.team.teamName}</span>
          </div>
        </div>

        {/* Seat Quota & License Key Card */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 mb-8">
          {/* Seat Quota Card */}
          <div
            className={`rounded-xl border p-5 ${
              isDarkMode ? 'border-slate-700 bg-slate-700/40' : 'border-gray-200 bg-white'
            }`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Team Seat Allocation
              </span>
              <span className="text-xs font-bold text-indigo-500">
                {allocatedSeats} / {maxSeats} Seats Occupied ({seatPercent}%)
              </span>
            </div>
            <div className={`h-2.5 w-full rounded-full overflow-hidden ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'}`}>
              <div
                className="h-full bg-gradient-to-r from-sky-500 to-indigo-600 transition-all duration-300"
                style={{ width: `${seatPercent}%` }}></div>
            </div>
            <p className={`mt-3 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Enterprise plan includes pooled built-in Cloud API task capacity for all team members.
            </p>
          </div>

          {/* Shared License Key Card */}
          <div
            className={`rounded-xl border p-5 ${
              isDarkMode ? 'border-slate-700 bg-slate-700/40' : 'border-gray-200 bg-white'
            }`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <FiKey className="h-4 w-4 text-sky-500" />
                <span className={`text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Enterprise License Key
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowLicenseKey(!showLicenseKey)}
                className="text-[11px] font-semibold text-sky-500 hover:underline">
                {showLicenseKey ? 'Hide' : 'Reveal'}
              </button>
            </div>
            <div className="flex items-center space-x-2 mt-2">
              <input
                type={showLicenseKey ? 'text' : 'password'}
                readOnly
                value={settings.team.licenseKey}
                className={`w-full rounded-lg border p-2 text-xs font-mono ${
                  isDarkMode
                    ? 'border-slate-600 bg-slate-800 text-gray-200'
                    : 'border-gray-300 bg-gray-50 text-gray-800'
                }`}
              />
              <button
                type="button"
                onClick={handleCopyLicenseKey}
                className="inline-flex items-center space-x-1 rounded-lg bg-sky-600 px-3 py-2 text-xs font-semibold text-white shadow hover:bg-sky-700 transition-colors">
                {copiedKey ? <FiCheck className="h-4 w-4" /> : <FiCopy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Invite Team Member Form */}
        <div
          className={`rounded-xl border p-5 mb-8 ${isDarkMode ? 'border-slate-700 bg-slate-700/30' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center space-x-2 mb-3">
            <FiUserPlus className="h-5 w-5 text-indigo-500" />
            <h3 className={`text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              Invite Team Member
            </h3>
          </div>
          <form onSubmit={handleInviteMember} className="flex flex-col md:flex-row gap-3">
            <div className="flex-1 relative">
              <input
                type="email"
                required
                placeholder="colleague@company.com"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                className={`w-full rounded-lg border p-2.5 pl-9 text-xs ${
                  isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-200' : 'border-gray-300 bg-white text-gray-800'
                }`}
              />
              <FiMail className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
            </div>

            <select
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as 'admin' | 'member')}
              className={`rounded-lg border p-2.5 text-xs ${
                isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-200' : 'border-gray-300 bg-white text-gray-800'
              }`}>
              <option value="member">Role: Member</option>
              <option value="admin">Role: Admin</option>
            </select>

            <button
              type="submit"
              disabled={isInviting}
              className="inline-flex items-center justify-center space-x-2 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 px-5 py-2.5 text-xs font-bold text-white shadow hover:from-sky-600 hover:to-indigo-700 transition-all">
              <FiUserPlus className="h-4 w-4" />
              <span>{inviteSuccess ? 'Invite Sent!' : 'Send Seat Invitation'}</span>
            </button>
          </form>
        </div>

        {/* Team Members List Table */}
        <div className="space-y-3">
          <h3 className={`text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            Active Seats & Members ({members.length})
          </h3>

          <div className={`overflow-x-auto rounded-xl border ${isDarkMode ? 'border-slate-700' : 'border-gray-200'}`}>
            <table className="w-full text-left text-xs">
              <thead
                className={`${isDarkMode ? 'bg-slate-700/60 text-gray-300' : 'bg-gray-100 text-gray-700'} uppercase font-semibold`}>
                <tr>
                  <th className="p-3.5">Member</th>
                  <th className="p-3.5">Role</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5">Added Date</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {members.map(member => (
                  <tr
                    key={member.id}
                    className={`${isDarkMode ? 'hover:bg-slate-700/20' : 'hover:bg-gray-50'} transition-colors`}>
                    <td className="p-3.5">
                      <div className="flex items-center space-x-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 font-bold text-white uppercase text-xs shadow-sm">
                          {member.email.substring(0, 2)}
                        </div>
                        <span className={`font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>
                          {member.email}
                        </span>
                      </div>
                    </td>
                    <td className="p-3.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          member.role === 'owner'
                            ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                            : member.role === 'admin'
                              ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                              : 'bg-slate-700 text-gray-300'
                        }`}>
                        {member.role.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-3.5">
                      <span
                        className={`inline-flex items-center space-x-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          member.status === 'active'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-amber-500/20 text-amber-400'
                        }`}>
                        {member.status === 'active' ? (
                          <FiUserCheck className="h-3 w-3" />
                        ) : (
                          <FiClock className="h-3 w-3" />
                        )}
                        <span>{member.status === 'active' ? 'Active' : 'Pending Invite'}</span>
                      </span>
                    </td>
                    <td className={`p-3.5 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                      {new Date(member.addedAt).toLocaleDateString()}
                    </td>
                    <td className="p-3.5 text-right">
                      {member.role !== 'owner' && (
                        <button
                          type="button"
                          onClick={() => handleRemoveMember(member.id)}
                          className="rounded-lg p-1.5 text-red-400 hover:bg-red-500/10 transition-colors"
                          title="Revoke seat access">
                          <FiTrash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
};
