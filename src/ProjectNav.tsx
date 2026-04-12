// ProjectNav — dropdown for switching, creating, and deleting projects
// Uses createPortal so the dropdown escapes parent overflow:hidden containers.

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { ProjectConfig } from "./api/canvasFiles";
import { connectProjectApi, deleteProjectApi } from "./api/canvasFiles";

interface Props {
  projects: ProjectConfig[];
  activeProject: ProjectConfig;
  onSwitch: (index: number) => void;
  onProjectsChanged: () => void;
}

export default function ProjectNav({ projects, activeProject, onSwitch, onProjectsChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setConfirmDelete(null);
  }, []);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const handleConnect = useCallback(async () => {
    const path = newPath.trim();
    const name = newName.trim();
    if (!path) return;
    try {
      await connectProjectApi(path, name || undefined);
      setNewName("");
      setNewPath("");
      setCreating(false);
      onProjectsChanged();
    } catch (err) {
      console.error("Failed to connect project:", err);
    }
  }, [newName, newPath, onProjectsChanged]);

  const handleDelete = useCallback(async (projectId: string) => {
    try {
      await deleteProjectApi(projectId);
      setConfirmDelete(null);
      onProjectsChanged();
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  }, [onProjectsChanged]);

  // Compute dropdown position from trigger button
  const rect = triggerRef.current?.getBoundingClientRect();
  const dropdownTop = rect ? rect.bottom + 6 : 60;
  const dropdownLeft = rect ? rect.left : 10;

  return (
    <div className="project-nav">
      <button
        ref={triggerRef}
        className="project-nav-trigger"
        onClick={() => { setOpen(!open); setCreating(false); setConfirmDelete(null); }}
      >
        <span className="project-nav-icon">&#x25E2;</span>
        {activeProject.name}
        <span className="project-nav-chevron">{open ? "\u25B4" : "\u25BE"}</span>
      </button>

      {open && createPortal(
        <>
        <div className="project-nav-backdrop" onClick={closeDropdown} />
        <div
          ref={dropdownRef}
          className="project-nav-dropdown"
          style={{ position: "fixed", top: dropdownTop, left: dropdownLeft, zIndex: 10001 }}
        >
          <div className="project-nav-label">Projects</div>

          <div className="project-nav-list">
            {projects.map((p, i) => (
              <div
                key={p.id}
                className={`project-nav-item ${p.id === activeProject.id ? "project-nav-item--active" : ""}`}
              >
                <button
                  className="project-nav-item-btn"
                  onClick={() => { onSwitch(i); setOpen(false); }}
                >
                  <span className="project-nav-item-name">{p.name}</span>
                </button>

                {p.id !== activeProject.id && (
                  confirmDelete === p.id ? (
                    <div className="project-nav-confirm">
                      <span>Delete?</span>
                      <button className="project-nav-confirm-yes" onClick={() => handleDelete(p.id)}>Yes</button>
                      <button className="project-nav-confirm-no" onClick={() => setConfirmDelete(null)}>No</button>
                    </div>
                  ) : (
                    <button
                      className="project-nav-delete"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(p.id); }}
                      title="Delete project"
                    >
                      &times;
                    </button>
                  )
                )}
              </div>
            ))}
          </div>

          {creating ? (
            <div className="project-nav-create-form">
              <input
                ref={inputRef}
                className="project-nav-create-input"
                type="text"
                placeholder="/path/to/project"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                  if (e.key === "Escape") { setCreating(false); setNewPath(""); setNewName(""); }
                }}
              />
              <input
                className="project-nav-create-input"
                type="text"
                placeholder="Name (optional)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleConnect();
                }}
              />
              <button
                className="project-nav-create-submit"
                onClick={handleConnect}
                disabled={!newPath.trim()}
              >
                Connect
              </button>
            </div>
          ) : (
            <button
              className="project-nav-new-btn"
              onClick={() => setCreating(true)}
            >
              + Connect Project
            </button>
          )}
        </div>
        </>,
        document.body
      )}
    </div>
  );
}
