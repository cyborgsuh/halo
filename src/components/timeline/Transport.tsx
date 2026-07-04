// timeline/Transport.tsx
//
// The transport row: play/pause, a time readout, Add-zoom, and the horizontal
// zoom controls (in / out / fit). All shadcn vocabulary (Button + Tooltip).

import { Maximize2, Pause, Play, Plus, Scissors, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fmtClockMs } from "./shared";

export interface TransportProps {
  playing: boolean;
  onTogglePlay: () => void;
  playheadMs: number;
  durationMs: number;
  onAddZoom: () => void;
  onAddCut: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomToFit: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

export default function Transport(props: TransportProps) {
  return (
    <div className="flex items-center gap-3">
      <Button
        size="icon"
        variant="secondary"
        onClick={props.onTogglePlay}
        aria-label={props.playing ? "Pause" : "Play"}
      >
        {props.playing ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </Button>

      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        <span className="text-foreground">{fmtClockMs(props.playheadMs)}</span>
        {" / "}
        {fmtClockMs(props.durationMs)}
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="sm" variant="outline" onClick={props.onAddZoom}>
                <Plus className="size-4" /> Zoom
              </Button>
            }
          />
          <TooltipContent>Add a zoom region at the playhead</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="sm" variant="outline" onClick={props.onAddCut}>
                <Scissors className="size-4" /> Cut
              </Button>
            }
          />
          <TooltipContent>Remove a section at the playhead</TooltipContent>
        </Tooltip>

        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={props.onZoomOut}
                  disabled={!props.canZoomOut}
                  aria-label="Zoom out timeline"
                >
                  <ZoomOut className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Zoom out</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={props.onZoomToFit}
                  aria-label="Fit timeline to width"
                >
                  <Maximize2 className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Zoom to fit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={props.onZoomIn}
                  disabled={!props.canZoomIn}
                  aria-label="Zoom in timeline"
                >
                  <ZoomIn className="size-4" />
                </Button>
              }
            />
            <TooltipContent>Zoom in</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
