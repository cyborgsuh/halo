// mp4demuxer.ts — an mp4box.js-backed `Demuxer` for the export decode path.
//
// WebView2 has no built-in MP4 demuxer, so export's frame-accurate WebCodecs
// `VideoDecoder` path needs one injected (see export.ts ExportSource.demuxer).
// Without it export falls back to per-frame <video> seeking, which is slow enough
// to look stuck at 0%. This turns screen.mp4 bytes into a VideoDecoderConfig +
// decode-ordered EncodedVideoChunks.

import * as MP4Box from "mp4box";

import type { Demuxer, DemuxedTrack } from "@/lib/export";

// mp4box's box objects + many fields aren't in its published types; this adapter
// is a thin glue layer over a known-shape external lib, so reach in with `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Pull the avcC/hvcC codec-private bytes out of the track for VideoDecoderConfig.description. */
function descriptionFor(file: any, trackId: number): Uint8Array {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const DataStream = (MP4Box as any).DataStream;
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  throw new Error("mp4demuxer: no codec description (avcC) in track");
}

export function createMp4Demuxer(): Demuxer {
  return {
    demux(data: Uint8Array): Promise<DemuxedTrack> {
      return new Promise<DemuxedTrack>((resolve, reject) => {
        const file: any = (MP4Box as any).createFile();
        const chunks: EncodedVideoChunk[] = [];
        let config: VideoDecoderConfig | null = null;
        let expected = Infinity;
        let settled = false;

        const done = () => {
          if (settled) return;
          settled = true;
          if (config) resolve({ config, chunks });
          else reject(new Error("mp4demuxer: no decodable video track"));
        };

        file.onError = (e: string) => {
          if (!settled) {
            settled = true;
            reject(new Error("mp4demuxer: " + e));
          }
        };

        file.onReady = (info: any) => {
          const track = info.videoTracks?.[0];
          if (!track) {
            reject(new Error("mp4demuxer: no video track"));
            return;
          }
          expected = track.nb_samples;
          config = {
            codec: track.codec,
            codedWidth: track.video.width,
            codedHeight: track.video.height,
            description: descriptionFor(file, track.id),
          };
          file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
          file.start();
        };

        file.onSamples = (_id: number, _user: unknown, samples: any[]) => {
          for (const s of samples) {
            chunks.push(
              new EncodedVideoChunk({
                type: s.is_sync ? "key" : "delta",
                timestamp: (s.cts * 1_000_000) / s.timescale,
                duration: (s.duration * 1_000_000) / s.timescale,
                data: s.data,
              }),
            );
          }
          if (chunks.length >= expected) done();
        };

        // Feed the whole file at once (we already have all bytes in memory).
        const ab = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer & { fileStart: number };
        ab.fileStart = 0;
        file.appendBuffer(ab);
        file.flush();
      });
    },
  };
}
