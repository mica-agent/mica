import { useEffect } from "react";
import type { LayerId, CardMeta } from "../api/layerFiles";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  filename: string;
  html: string;
  exports: string[];
  meta: CardMeta;
  projectId: string;
  layerId: LayerId;
  layerColor: string;
  onClose: () => void;
  onEdit: () => void;
}

export default function ExpandedCardView({ filename, html, exports: exportFns, meta, projectId, layerId, layerColor, onClose, onEdit }: Props) {
  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="wb-expanded-overlay" onClick={onClose}>
      <div
        className="wb-expanded-card"
        style={{ "--layer-color": layerColor } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wb-expanded-header">
          <span className="wb-card-type">{meta.badge}</span>
          <span className="wb-expanded-title">{meta.title}</span>
          <div className="wb-expanded-actions">
            <button className="wb-btn wb-btn--tool" onClick={onEdit}>
              Edit
            </button>
            <button
              className="wb-card-btn"
              onClick={onClose}
              style={{ fontSize: "1.2rem" }}
            >
              &times;
            </button>
          </div>
        </div>

        <div className="wb-expanded-body">
          <WidgetRuntime
            html={html}
            exports={exportFns}
            project={projectId}
            layer={layerId}
            filename={filename}
          />
        </div>

        <div className="wb-expanded-footer">
          <span className="wb-expanded-filename">{filename}</span>
        </div>
      </div>
    </div>
  );
}
