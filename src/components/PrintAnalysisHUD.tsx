import React, { useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { analyzeSceneMechanicalWeaknesses, type WeakSpot } from '../utils/printAnalysis';
import {
  ShieldAlert,
  AlertTriangle,
  Info,
  CheckCircle2,
  X,
  Target,
} from 'lucide-react';

interface PrintAnalysisHUDProps {
  activeSpotId?: string | null;
  onSelectSpot?: (spot: WeakSpot | null) => void;
}

export const PrintAnalysisHUD: React.FC<PrintAnalysisHUDProps> = ({
  activeSpotId,
  onSelectSpot,
}) => {
  const sceneGraph = useStore(state => state.sceneGraph);
  const printAnalysisEnabled = useStore(state => state.printAnalysisEnabled);
  const setPrintAnalysisEnabled = useStore(state => state.setPrintAnalysisEnabled);
  const setSelectedNodeId = useStore(state => state.setSelectedNodeId);

  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('all');
  const [severityFilter, _setSeverityFilter] = useState<string>('all');

  const analysis = useMemo(() => {
    if (!printAnalysisEnabled || !sceneGraph) return null;
    return analyzeSceneMechanicalWeaknesses(sceneGraph);
  }, [sceneGraph, printAnalysisEnabled]);

  if (!printAnalysisEnabled || !analysis) return null;

  const { score, counts, weakSpots } = analysis;

  const filteredSpots = weakSpots.filter(spot => {
    if (selectedCategoryFilter !== 'all' && spot.category !== selectedCategoryFilter) return false;
    if (severityFilter !== 'all' && spot.severity !== severityFilter) return false;
    return true;
  });

  let scoreColor = 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10';
  let scoreBadge = 'High Integrity';
  if (score < 50) {
    scoreColor = 'text-red-500 border-red-500/30 bg-red-500/10';
    scoreBadge = 'Critical Risk';
  } else if (score < 80) {
    scoreColor = 'text-amber-500 border-amber-500/30 bg-amber-500/10';
    scoreBadge = 'Moderate Risk';
  }

  const handleItemClick = (spot: WeakSpot) => {
    if (spot.nodeId) setSelectedNodeId(spot.nodeId);
    if (onSelectSpot) {
      onSelectSpot(activeSpotId === spot.id ? null : spot);
    }
  };

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 w-[94%] max-w-xl bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-3.5 transition-all">
      {/* Header Bar */}
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2 mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-blue-500/10 dark:bg-blue-500/20 text-blue-500 rounded-lg">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
              Mechanical & 3D Print Failure Inspector
            </h3>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              Evaluated across 22 structural, kinematic, and 3D printing failure modes
            </p>
          </div>
        </div>

        {/* Score Badge */}
        <div className="flex items-center gap-2">
          <div className={`px-2.5 py-1 rounded-full border text-xs font-black tracking-wide flex items-center gap-1.5 ${scoreColor}`}>
            <span>{score}/100</span>
            <span className="text-[9px] font-semibold opacity-90 hidden sm:inline">{scoreBadge}</span>
          </div>
          <button
            onClick={() => setPrintAnalysisEnabled(false)}
            className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
            title="Close Inspector"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Category Filter Tabs */}
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-1 text-[10px] overflow-x-auto pb-1">
          <button
            onClick={() => setSelectedCategoryFilter('all')}
            className={`px-2 py-0.5 rounded-md font-semibold transition-all cursor-pointer ${
              selectedCategoryFilter === 'all'
                ? 'bg-blue-500 text-white shadow-xs'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
            }`}
          >
            All ({weakSpots.length})
          </button>
          <button
            onClick={() => setSelectedCategoryFilter('structural')}
            className={`px-2 py-0.5 rounded-md font-semibold transition-all cursor-pointer ${
              selectedCategoryFilter === 'structural'
                ? 'bg-blue-500 text-white shadow-xs'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
            }`}
          >
            Structural ({counts.structural})
          </button>
          <button
            onClick={() => setSelectedCategoryFilter('manufacturing')}
            className={`px-2 py-0.5 rounded-md font-semibold transition-all cursor-pointer ${
              selectedCategoryFilter === 'manufacturing'
                ? 'bg-blue-500 text-white shadow-xs'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
            }`}
          >
            3D Print ({counts.manufacturing})
          </button>
          <button
            onClick={() => setSelectedCategoryFilter('hardware')}
            className={`px-2 py-0.5 rounded-md font-semibold transition-all cursor-pointer ${
              selectedCategoryFilter === 'hardware'
                ? 'bg-blue-500 text-white shadow-xs'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
            }`}
          >
            Hardware ({counts.hardware})
          </button>
        </div>
      </div>

      {/* Weak Spots Summary List (Clickable items that highlight in 3D canvas) */}
      <div className="max-h-40 overflow-y-auto pr-1 space-y-1.5">
        {filteredSpots.length === 0 ? (
          <div className="p-3 text-center text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded-lg flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>No mechanical weak spots detected in this category!</span>
          </div>
        ) : (
          filteredSpots.map(spot => {
            const isActive = activeSpotId === spot.id;
            return (
              <div
                key={spot.id}
                onClick={() => handleItemClick(spot)}
                className={`p-2 rounded-lg border text-[11px] flex items-start justify-between gap-2 cursor-pointer transition-all ${
                  isActive
                    ? 'bg-blue-500/10 border-blue-500/60 shadow-xs'
                    : 'bg-slate-50 dark:bg-slate-800/60 border-slate-200/60 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-start gap-2">
                  {spot.severity === 'critical' && <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />}
                  {spot.severity === 'warning' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />}
                  {spot.severity === 'info' && <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />}
                  <div>
                    <div className="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1">
                      <span>{spot.title}</span>
                      {isActive && <Target className="w-3 h-3 text-blue-500 shrink-0" />}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">{spot.description}</div>
                  </div>
                </div>
                <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 shrink-0">
                  {spot.nodeName}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
