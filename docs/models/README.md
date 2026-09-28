# On-device model artefacts

`src/lib/onnx-session.js` will run a transformer classifier inside the extension
once two things are present. Neither is in this repository, and neither will be.

```
frontend/extension/
  vendor/ort/ort.wasm.bundle.min.mjs     <- vendored onnxruntime-web
  vendor/ort/ort-wasm-simd-threaded.wasm  <- vendored onnxruntime-web
  models/classifier.onnx                  <- your exported checkpoint
  models/vocab.txt                        <- the vocabulary that checkpoint was trained with
```

Until all four exist, the extension runs the heuristic scorer in
`src/lib/local-classifier.js` and says so in the popup. That is the intended
default, not a failure state: the heuristic is a real, explainable lexical
model, it needs no asset and no permissions, and it is what every test runs
against.

## Why nothing is committed

* **Size.** A competitive text-classification checkpoint is 60-110 MB. The
  Web Store review limit and this repository's clone time both get worse by
  that much, for an artefact nobody reads.
* **Provenance.** A `.onnx` blob in a source tree is unauditable. Reviewing
  "the weights came from this checkpoint, exported by this script" is possible;
  reviewing a binary is not.
* **Licensing.** The weights inherit the checkpoint's licence and the runtime's
  binaries inherit Apache-2.0. Neither should be re-distributed from a
  volunteer project by accident.

`.gitignore` already excludes `*.onnx`, and the paths above are excluded too, so
an installed model cannot be committed by accident.

## 1. Export a checkpoint to ONNX

Any sequence-classification fine-tune works. The columns are described in
"Label order" below - read it before choosing a head, because the extension
trusts the order it is given.

```bash
pip install optimum[exporters] torch onnx
```

```python
# export_model.py
from optimum.exporters.onnx import main_export

main_export(
    model_name_or_path="<your-hf-checkpoint-id>",
    output="models/classifier",
    task="text-classification",
    opset=17,          # 17 is the floor onnxruntime-web 1.20 supports
    device="cpu",
    do_validation=True,
)
```

`do_validation=True` is not optional politeness. `optimum` prints a
`[-0.001, 0.002]`-style accuracy difference on random input; if that number is
wild, the export is wrong and the extension will happily serve nonsense with
full confidence.

Then quantise, which is what makes a ~110 MB checkpoint loadable at all:

```bash
pip install onnxruntime onnx
python - <<'PY'
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("models/classifier/model.onnx", "models/classifier/classifier.onnx",
                 weight_type=QuantType.QInt8)
PY
```

Finally place the artefacts where the loader looks:

```bash
mkdir -p frontend/extension/models
cp models/classifier/classifier.onnx frontend/extension/models/classifier.onnx
```

## 2. Export the matching vocabulary

The tokenizer is trained with the checkpoint, so the ids it emits are only
meaningful against *that* checkpoint's vocabulary. A `vocab.txt` from a
different model produces ids that are in range and mean nothing - the model will
not error, it will just be wrong.

```bash
python - <<'PY'
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained("<your-hf-checkpoint-id>")
with open("frontend/extension/models/vocab.txt", "w", encoding="utf-8") as fh:
    for token, _ in sorted(tok.get_vocab().items(), key=lambda kv: kv[1]):
        fh.write(token + "\n")
PY
```

One token per line, index = line number. That positional rule is why
`tokenizer.js` numbers the file by line rather than by order of appearance: the
embedding rows in the checkpoint are indexed the same way.

## 3. Vendor onnxruntime-web

```bash
npm pack onnxruntime-web@1.20.1
tar -xzf onnxruntime-web-1.20.1.tgz
mkdir -p frontend/extension/vendor/ort
cp package/dist/ort.wasm.bundle.min.mjs          frontend/extension/vendor/ort/
cp package/dist/ort-wasm-simd-threaded.wasm      frontend/extension/vendor/ort/
```

Use `ort.wasm.bundle.min.mjs`, not the `ort.webgpu.bundle.min.mjs` variant,
unless you also change `RUNTIME_MODULE_PATH` in `src/lib/onnx-session.js` and
`executionProviders`. The WebGPU build is faster but unavailable on Linux and on
older integrated GPUs, and it fails at session-creation time rather than at load
time on those machines.

`ort-wasm-simd-threaded.wasm` must sit next to the `.mjs`. `onnx-session.js`
points `ort.env.wasm.wasmPaths` at `vendor/ort/` for exactly this reason; if you
vendor only the `.mjs`, the session fails at instantiation with a fetch error
that does not mention the missing file.

## 4. Reload and check

Load the unpacked extension, then open the popup. The "On-device model" line
reads one of:

| Status | Meaning | Action |
| --- | --- | --- |
| Ready | runtime vendored, model installed, session built | nothing |
| Model installed | runtime vendored, model installed, not loaded yet | nothing; it loads on first use |
| No model installed | `models/classifier.onnx` is not in the package | steps 1-2 |
| onnxruntime-web not vendored | `vendor/ort/` is empty or incomplete | step 3 |
| Model not readable here | the files exist but this context cannot fetch them | see below |

## Label order

The two scores the rest of the extension uses are different questions:

* `aiScore` - was this text written by a machine.
* `newsScore` - is a claim here likely to be false.

A single binary classifier cannot honestly answer both, so the expected head is
a two-output model, and `DEFAULT_CHANNEL_MAP` in `src/lib/local-classifier.js`
reads column 1 as `aiScore` and column 0 as `newsScore`. The columns are squashed
independently with a sigmoid, not as a 2-way softmax, because forcing them to sum
to 1 would make "90% machine-generated" and "90% misinformation" mutually
exclusive.

A one-output model is also accepted: it fills `aiScore` by default, and
`singleChannel: "news"` switches that. `classify()` reports which axes were
actually scored (`aiScored` / `newsScored`) so a caller can tell "the model said
no" from "the model did not look".

Get the order wrong and the extension does not error. It inverts one score and
hides posts for the wrong reason. That is why the map is a constant with a
comment rather than something inferred from the model's own config.

## Two platform constraints that are not negotiable

**WebAssembly is off by default.** Manifest V3's `extension_pages` policy is
`script-src 'self'; object-src 'self';` and that disables WASM entirely. This
repository declares:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
}
```

`'wasm-unsafe-eval'` is the only addition Chrome permits here, and it is
asserted by a test in `src/lib/onnx-session.test.js`. Remove it and
`InferenceSession.create` fails at instantiation.

**A content script cannot read a packaged file.** Reading
`chrome.runtime.getURL("models/classifier.onnx")` from `src/script.js` requires
the file to be in `web_accessible_resources`, and this repository deliberately
declares none - `src/lib/manifest.test.js` pins its absence, because the
placeholder no longer needs a web-accessible image and a blanket
`resources: ["models/*"]` would expose it to every site the user visits.

The consequence is the honest one: the ONNX path runs in the service worker and
in extension pages, and the content script degrades to the heuristic and reports
`Model not readable here`. If the transformer has to run in the content script,
that is a manifest decision with a security trade-off attached, and it should be
made deliberately rather than by an import that happens to work on a dev build.

Either way the extension is correct without any of the above: no asset, no
runtime, and the heuristic is what runs.
