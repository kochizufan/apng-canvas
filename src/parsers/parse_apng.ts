"use strict";

import Animation, {Frame} from '../utils/animation';
import { support } from '../utils/support';
import crc32 from './crc32';
import {
  makeDWordArray,
  makeStringArray,
  ParseCallback,
  ParseOptions,
  readByte,
  readDWord,
  readString,
  readWord,
  subBuffer
} from './parse_base';

/**
 * @param {ArrayBuffer} buffer
 * @param {ParseOptions} options
 * @return {Promise}
 */
export default async function (buffer: ArrayBufferLike, options: ParseOptions = { ignoreSingle: false, forceLoop: false}): Promise<Animation> {
  const ignoreSingle = !!(options.ignoreSingle);
  const forceLoop = !!(options.forceLoop);
  const bytes = new Uint8Array(buffer);
  return new Promise((resolve, reject) => {
    // fast animation test
    let isAnimated = false;
    parseChunks(bytes, (type, _bytes, _off, _length) =>  {
      if (type === "acTL") {
        isAnimated = true;
        return false;
      }
      return true;
    });
    if (!isAnimated && ignoreSingle) {
      reject("Not an animated PNG");
      return;
    }

    const preDataParts:Uint8Array[] = [], postDataParts:Uint8Array[] = [], anim = new Animation();
    let headerDataBytes:Uint8Array | undefined, frame: Partial<Frame> | undefined;

    parseChunks(bytes, function (type, bytes, off, length) {
      switch (type) {
        case "IHDR":
          headerDataBytes = bytes.subarray(off + 8, off + 8 + length);
          anim.width = readDWord(bytes, off + 8, true);
          anim.height = readDWord(bytes, off + 12, true);
          break;
        case "acTL":
          anim.numPlays = readDWord(bytes, off + 8 + 4, true);
          break;
        case "fcTL":
          if (frame) anim.frames.push(frame as Frame);
          frame = {};
          frame.width = readDWord(bytes, off + 8 + 4, true);
          frame.height = readDWord(bytes, off + 8 + 8, true);
          frame.left = readDWord(bytes, off + 8 + 12, true);
          frame.top = readDWord(bytes, off + 8 + 16, true);
          const delayN = readWord(bytes, off + 8 + 20, true);
          let delayD = readWord(bytes, off + 8 + 22, true);
          if (delayD == 0) delayD = 100;
          frame.delay = 1000 * delayN / delayD;
          // see http://mxr.mozilla.org/mozilla/source/gfx/src/shared/gfxImageFrame.cpp#343
          if (frame.delay <= 10) frame.delay = 100;
          anim.playTime += frame.delay;
          frame.disposeOp = readByte(bytes, off + 8 + 24);
          frame.blendOp = readByte(bytes, off + 8 + 25);
          frame.dataParts = [];
          break;
        case "fdAT":
          if (frame) frame.dataParts!.push(bytes.subarray(off + 8 + 4, off + 8 + length));
          break;
        case "IDAT":
          if (frame) frame.dataParts!.push(bytes.subarray(off + 8, off + 8 + length));
          else {
            frame = {};
            frame.width = anim.width;
            frame.height = anim.height;
            frame.left = 0;
            frame.top = 0;
            frame.delay = 100;
            anim.playTime += frame.delay;
            frame.disposeOp = 1;
            frame.blendOp = 1;
            frame.dataParts = [bytes.subarray(off + 8, off + 8 + length)];
          }
          break;
        case "IEND":
          postDataParts.push(subBuffer(bytes, off, 12 + length));
          break;
        default:
          preDataParts.push(subBuffer(bytes, off, 12 + length));
      }
      return true;
    });

    if (frame) anim.frames.push(frame as Frame);

    if (anim.frames.length <= 1) {
      if (ignoreSingle) {
        reject("Not an animated PNG");
        return;
      } else {
        anim.numPlays = 1;
      }
    } else if (forceLoop) anim.numPlays = 0;

    // creating images
    let createdImages = 0;
    const preBlob = new Blob(preDataParts), postBlob = new Blob(postDataParts);
    for (let f = 0; f < anim.frames.length; f++) {
      frame = anim.frames[f];

      let bb: BlobPart[] = [];
      bb.push(support.PNG_SIGNATURE_BYTES);
      headerDataBytes!.set(makeDWordArray(frame.width!, true), 0);
      headerDataBytes!.set(makeDWordArray(frame.height!, true), 4);
      bb.push(makeChunkBytes("IHDR", headerDataBytes!));
      bb.push(preBlob);
      for (let j = 0; j < frame.dataParts!.length; j++) {
        bb.push(makeChunkBytes("IDAT", frame.dataParts![j]));
      }
      bb.push(postBlob);
      const url = URL.createObjectURL(new Blob(bb, {"type": "image/png"}));
      delete frame.dataParts;
      bb = [];

      /**
       * Using "createElement" instead of "new Image" because of bug in Chrome 27
       * https://code.google.com/p/chromium/issues/detail?id=238071
       * http://stackoverflow.com/questions/16377375/using-canvas-drawimage-in-chrome-extension-content-script/16378270
       */
      frame.img = document.createElement('img');
      frame.img.onload = function () {
        URL.revokeObjectURL(this.src);
        createdImages++;
        if (createdImages === anim.frames.length) {
          resolve(anim);
        }
      };
      frame.img.onerror = function () {
        reject("Image creation error");
      };
      frame.img.src = url;
    }
  });
};

/**
 * @param {Uint8Array} bytes
 * @param {function(string, Uint8Array, int, int)} callback
 */
function parseChunks(bytes: Uint8Array, callback: ParseCallback) {
  let off = 8;
  let type: string, res = true;
  do {
    const length = readDWord(bytes, off, true);
    type = readString(bytes, off + 4, 4);
    res = callback(type, bytes, off, length);
    off += 12 + length;
  } while (res && type != "IEND" && off < bytes.length);
}

/**
 * @param {string} type
 * @param {Uint8Array} dataBytes
 * @return {Uint8Array}
 */
function makeChunkBytes(type: string, dataBytes: Uint8Array): Uint8Array {
  const crcLen = type.length + dataBytes.length;
  const bytes = new Uint8Array(new ArrayBuffer(crcLen + 8));
  bytes.set(makeDWordArray(dataBytes.length,true), 0);
  bytes.set(makeStringArray(type), 4);
  bytes.set(dataBytes, 8);
  const crc = crc32(bytes, 4, crcLen);
  bytes.set(makeDWordArray(crc, true), crcLen + 4);
  return bytes;
}

