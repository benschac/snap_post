# Snap to Post: the ML/AI 80/20 ramp-up

Updated: 2026-08-18  
Audience: a product engineer building a fast, multimodal product-identification system without prior ML specialization.

## The goal

You do not need to become an ML researcher before building Snap. You need enough ML judgment to:

1. frame the problem correctly;
2. build an evaluation that cannot lie to you;
3. determine whether a failure comes from data, retrieval, ranking, a model, or the surrounding system;
4. decide when training is justified;
5. measure the quality/latency/coverage tradeoff on a physical iPhone;
6. communicate precisely with ML researchers or specialists when one becomes necessary.

The central mental model is:

```text
observation
  -> choose useful frames and audio
  -> extract exact and semantic signals
  -> retrieve candidates with high recall
  -> rerank candidates
  -> verify external evidence
  -> answer at the supported identity level or abstain
  -> learn from review
```

The model is one component. The product is the entire decision system.

## The eight concepts that matter most

### 1. Problem framing and knowability

Learn the difference between:

- **classification:** choose from a predefined label set;
- **object detection:** locate and broadly classify objects in an image;
- **segmentation:** identify the pixels belonging to an object;
- **instance/product retrieval:** find the same object model or SKU in a catalog;
- **entity resolution:** combine imperfect records and evidence into one canonical identity;
- **open-set recognition:** handle objects and models never represented during training;
- **out-of-distribution detection:** recognize that an input differs from the system's known data;
- **abstention/selective prediction:** return a broader answer or `unknown` instead of a precise unsupported answer;
- **multimodal fusion:** combine image, voice, OCR, barcode, metadata, and external evidence.

Snap is primarily open-world product retrieval plus entity resolution. A detector saying “air fryer” is useful routing metadata, not proof that an item is a specific Ninja model.

You understand this section when you can label an item as one of:

- category knowable;
- brand knowable;
- family knowable;
- exact model knowable;
- variant knowable;
- fundamentally unknowable from available evidence.

### 2. Evaluation before optimization

Learn:

- train, validation, and test splits;
- overfitting and generalization;
- data leakage;
- precision, recall, false-positive rate, and confusion matrices;
- top-k recall and ranking metrics;
- threshold selection;
- confidence calibration;
- slice-based evaluation;
- offline versus online evaluation.

Snap should not optimize one “accuracy” number. Its core quality metrics are:

| Metric | Product meaning |
|---|---|
| Candidate recall@5 | Was the correct product among the five retrieved candidates? |
| Exact-identity precision | When Snap claims an exact model, how often is it right? |
| Exact-identity coverage | For what fraction of items is Snap willing to make that claim? |
| False-exact rate | How often does Snap confidently name the wrong exact model? This is a critical guardrail. |
| Hierarchical accuracy | Was it correct at category, brand, family, model, and variant levels? |
| Evidence-backed rate | Did the answer include a valid canonical source? |
| Review correction rate | How often and how deeply did the user edit the result? |
| Time to first candidate | How quickly did useful identity information appear? |
| Time to post-ready | How quickly was the reviewable draft complete? |

Use product/SKU and physical-item holdouts. Never put two views of the same physical item into both training and test sets. Add time-based holdouts so old catalog data cannot make the evaluation look artificially current.

### 3. Data quality and the learning loop

Learn:

- ground truth versus weak or proxy labels;
- label noise and missing labels;
- class imbalance and long-tail distributions;
- hard negatives;
- dataset shift;
- active learning;
- augmentation;
- provenance, consent, licenses, and deletion;
- immutable events versus current projections.

The most important distinctions for Snap:

- an asking price is not a transaction price;
- a seller-written model is not a verified model;
- a missing brand is not evidence that the item is unbranded;
- multiple views of one listing are not independent same-product matches;
- the model's previous guess is not a label;
- an explicit user correction is a much stronger label than old free-form prose.

Active learning is especially valuable: prioritize human review of uncertain items, provider disagreements, new categories, and visually similar variants instead of labeling random examples.

### 4. Embeddings, retrieval, and ranking

Learn:

- what an embedding represents;
- cosine similarity and distance;
- nearest-neighbor and approximate-nearest-neighbor search;
- image-image, text-text, and image-text embeddings;
- lexical versus semantic retrieval;
- metadata filtering;
- hybrid search;
- candidate generation versus reranking;
- contrastive and metric learning;
- positive pairs, random negatives, and hard negatives.

The essential two-stage pattern is:

1. retrieve broadly and cheaply so the correct answer appears in the candidate set;
2. apply a slower, more accurate reranker to a small candidate set.

If the right item is absent from the top 20, training the reranker cannot help. If it is consistently in the top 5 but ranked second, the retrieval corpus is probably adequate and reranking is the likely opportunity.

For product identity, hybrid search is mandatory in spirit even if the implementation starts simply:

- exact tokens catch model numbers, UPCs, brands, and dimensions;
- image embeddings catch visual similarity;
- text embeddings connect spoken descriptions and catalog language;
- metadata prevents impossible matches;
- evidence quality influences the final rank.

### 5. Practical computer vision

Learn:

- transfer learning and pretrained encoders;
- convolutional networks and vision transformers at a conceptual level;
- input resolution, cropping, resizing, normalization, RGB/YUV, and orientation;
- detection versus classification versus segmentation;
- OCR and barcode recognition;
- zero-shot vision-language models;
- domain shift between catalog photography and cluttered used-item photography;
- augmentation for blur, lighting, rotation, occlusion, damage, and clutter.

Preprocessing is part of the model. A resize, color conversion, crop, or normalization mismatch between Python and iPhone can destroy accuracy while the model weights remain identical.

Do not train a convolutional network from scratch as a learning exercise for this product. Start with a pretrained embedding model and learn how input changes alter retrieval results.

### 6. On-device inference and systems performance

Learn:

- tensors, shapes, dtypes, model parameters, and operators;
- model export, graph lowering, delegates, and hardware backends;
- CPU, GPU, and Neural Engine tradeoffs;
- FP32, FP16, INT8, and quantization-aware training;
- model load, specialization, warmup, setup, and inference;
- zero-copy buffers and the cost of image conversion;
- thread scheduling, synchronization, batching, and backpressure;
- memory bandwidth and peak resident memory;
- cold versus warm latency;
- p50, p95, and p99 latency;
- thermal throttling and sustained performance.

Important truths:

- a model advertised as “10 ms inference” may still require 30 ms of preprocessing and 20 ms of buffer copying;
- GPU work can look asynchronous until a synchronization point blocks the critical path;
- quantization can improve latency and memory, but it must be checked for accuracy loss and actual backend delegation;
- a model that is fast for ten runs can throttle during a five-minute storage-unit session;
- average latency hides the stalls users feel;
- repeatedly loading or specializing a model can cost more than inference itself;
- simulator timing is not physical-device evidence.

Measure the end-to-end critical path and each internal span. Optimize the largest measured contributor, not the most interesting native technology.

### 7. LLMs, VLMs, RAG, and tool use

Learn:

- tokens and context windows at a high level;
- structured outputs and schema validation;
- tool/function calling;
- streaming partial results;
- hallucination and unsupported claims;
- retrieval-augmented generation;
- source provenance and freshness;
- prompt injection from retrieved web content;
- model/provider evaluation rather than model reputation.

Use a VLM to generate or compare candidates, interpret visible evidence, and structure observations. Do not let it silently establish official identity or current price. Those outputs require retrieved evidence and deterministic validation.

RAG is not only “search some documents and paste them into a prompt.” In Snap it means keeping changing facts and source evidence outside model weights, retrieving the relevant records, and letting models reason over a bounded candidate set.

### 8. Experiment design and ML operations

Learn:

- strong baselines;
- one-variable experiments and ablations;
- reproducible datasets, configurations, and model versions;
- shadow mode and human review;
- feedback-loop bias;
- data drift and catalog freshness;
- latency/quality/cost Pareto frontiers;
- canary releases and rollback boundaries.

Every experiment should state:

1. the hypothesis;
2. the fixed evaluation set and slices;
3. the one intentional change;
4. quality metrics;
5. latency, memory, and thermal metrics;
6. the decision threshold for keeping the change;
7. artifacts sufficient to reproduce it.

## Unknown unknowns that frequently fool product engineers

1. **Model confidence is not probability.** A score of `0.92` is not automatically a 92% chance of correctness. Calibration must be measured on representative data.
2. **Closed-set demos hide the real problem.** A classifier forced to choose among known labels will confidently choose one even when the correct product is absent.
3. **Identity is hierarchical.** Category may be certain while exact variant is unknowable. One flat accuracy score destroys that information.
4. **Retrieval creates a ceiling.** A reranker or LLM cannot select the correct product if candidate generation never retrieved it.
5. **Random train/test splits often lie.** Near-duplicate images, the same physical item, or the same SKU across splits inflate quality.
6. **Feedback data is selected, not random.** Users correct visible mistakes and may ignore subtle ones; training blindly on corrections creates bias.
7. **Missing labels are not negative labels.** “No model recorded” may mean no one looked.
8. **Multimodal signals are correlated.** Voice, OCR, and search results may repeat the same incorrect seller claim; three agreeing signals are not necessarily three independent confirmations.
9. **The fastest provider can change the answer distribution.** Racing providers and accepting the first result introduces a quality bias that must be evaluated.
10. **Offline and production preprocessing drift.** Python, Swift, VisionCamera, and ExecuTorch must use equivalent crops, rotation, color, normalization, and tensor layout.
11. **Caches hide cold-path failures.** Measure cold misses, warm hits, stale hits, and invalidation separately.
12. **Thermals are product behavior.** Continuous camera, radio, GPU, and Neural Engine work can change latency several minutes into a session.
13. **Current facts do not belong in weights.** Prices, stock, URLs, and catalog availability become stale and need provenance.
14. **A bigger model may reduce system accuracy.** Additional latency can delay capture, increase queueing, or cause the app to bind evidence to the wrong item.
15. **The label taxonomy is part of the product.** Changing what “same product” means—color variant, capacity, bundle, generation—changes the training target and evaluation.
16. **Commercial use has multiple licenses.** Model weights, code, dataset records, listing photos, generated embeddings, and output display may each have different terms.

## A focused 15–20 hour curriculum

Do this alongside the prototype. Do not wait to finish the curriculum before building.

### Block 1: ML evaluation fundamentals — 3–4 hours

Use the [Google Machine Learning Crash Course](https://developers.google.com/machine-learning/crash-course). Prioritize:

- datasets, generalization, and overfitting;
- classification thresholds, precision, and recall;
- embeddings;
- production ML systems.

Optional reinforcement:

- [Kaggle Intro to Machine Learning](https://www.kaggle.com/learn/intro-to-machine-learning): model validation and under/overfitting;
- [Kaggle Intermediate Machine Learning](https://www.kaggle.com/learn/intermediate-machine-learning): cross-validation and data leakage.

Kaggle's tabular examples are not the Snap architecture. Their value is learning how evaluations fail.

### Block 2: Computer vision and multimodal retrieval — 4–5 hours

Use selected portions of the [Hugging Face Community Computer Vision Course](https://huggingface.co/learn/computer-vision-course/unit0/welcome/welcome):

- fundamentals;
- transfer learning;
- multimodal models and image-text retrieval;
- basic CV tasks;
- model optimization;
- zero-shot computer vision.

Use [Kaggle Computer Vision](https://www.kaggle.com/learn/computer-vision) only for a quick conceptual pass through convolution, pooling, and augmentation. It uses TensorFlow/Keras; Snap's working model toolchain is PyTorch/ExecuTorch.

Keep [Stanford CS231n](https://cs231n.stanford.edu/2026/) as a deeper reference. Do not attempt the full ten-week course before prototyping.

### Block 3: PyTorch and transfer learning — 3–4 hours

Complete the relevant parts of [PyTorch Learn the Basics](https://docs.pytorch.org/tutorials/beginner/basics/intro.html):

- tensors;
- datasets and data loaders;
- transforms;
- model inference;
- optimization at a conceptual level;
- save/load and evaluation mode.

Then run one pretrained vision or image-embedding model over the Snap evaluation images. The goal is to understand the workflow, not to train a large model.

### Block 4: Edge deployment and profiling — 3–4 hours

Follow the [ExecuTorch Beginner Pathway](https://docs.pytorch.org/executorch/stable/pathway-beginner.html):

- export;
- lowering and delegates;
- iOS deployment;
- quantization basics;
- numerical debugging and profiling.

Also learn to profile the real app with [Apple Instruments for model runtime performance](https://developer.apple.com/documentation/CoreAI/analyzing-model-runtime-performance-with-instruments). Measure load, specialization, setup, inference, CPU/GPU/Neural Engine use, and repeated model loading.

### Block 5: Production ML judgment — 2–3 hours

Watch selected [Full Stack Deep Learning](https://fullstackdeeplearning.com/course/2022/) lectures:

- when to use ML;
- troubleshooting and testing;
- data management and annotation;
- deployment;
- continual learning and monitoring.

The course is older than parts of the model stack but its system-design lessons remain directly relevant.

## Six hands-on exercises worth more than another course

### Exercise 1: Build the knowability set

Label the first 30–50 objects at category, brand, family, model, and variant levels. Add `unknowable` at each level and record the evidence needed to resolve it.

Deliverable: `evaluation-items.jsonl` plus images and source URLs.

### Exercise 2: Build zero-training image retrieval

Run a pretrained image or image-text encoder over the images. For every query image, inspect the top five nearest items.

Deliverable: an HTML or notebook report showing each query, top-five candidates, distances, and correct/incorrect labels.

Lesson: understand embeddings, recall@k, domain shift, and the difference between visual similarity and product identity.

### Exercise 3: Construct hard negatives

For every exact product, deliberately add a confusing sibling: another capacity, generation, color, size, bundle, or visually similar brand.

Deliverable: a hard-negative slice and a baseline false-exact rate.

Lesson: easy random negatives make weak systems look excellent.

### Exercise 4: Add abstention

Choose a similarity/evidence threshold below which the system returns brand/family/category or `unknown`. Plot exact-identity precision against coverage.

Deliverable: a threshold table showing how much coverage must be sacrificed to hit the desired exact-identity precision.

Lesson: “I don't know” is a product capability, not a model failure.

### Exercise 5: Reproduce preprocessing across Python and iPhone

Save the selected source image and the final model tensor from both implementations. Compare orientation, crop, dimensions, dtype, range, channel order, and numerical difference.

Deliverable: a golden-input test and reference tensor.

Lesson: training/serving skew often masquerades as a bad model.

### Exercise 6: Measure a five-minute physical-device session

Trace capture selection, preprocessing, inference, upload, speech partials, candidate retrieval, VLM, source validation, and UI commits. Record p50/p95, memory, battery/thermal state, dropped frames, backlog depth, and model reloads.

Deliverable: one latency waterfall plus a sustained-session report.

Lesson: the fastest isolated inference is not necessarily the fastest product.

## What not to learn yet

Defer these until a measured bottleneck requires them:

- deriving backpropagation or attention equations by hand;
- training a transformer or vision foundation model from scratch;
- distributed multi-GPU training;
- RLHF, PPO, or reinforcement-learning theory;
- writing CUDA, Metal, C++, or Rust kernels without a profiler showing the need;
- designing a custom vector database or ANN algorithm;
- sophisticated synthetic-data pipelines;
- Kubernetes or heavy MLOps platforms;
- leaderboard-driven Kaggle competitions unrelated to open-world product identity.

You should understand what these are, but they are not on the critical path.

## Vocabulary checkpoint

You are ready to lead the first ML iteration when these terms feel operational rather than mysterious:

- feature, label, ground truth, proxy label;
- train/validation/test and leakage;
- overfitting, generalization, distribution shift;
- precision, recall, false positive, threshold;
- calibration, coverage, abstention;
- embedding, cosine similarity, nearest neighbor;
- recall@k, reranker, hard negative;
- classifier, detector, segmenter, OCR;
- zero-shot, transfer learning, fine-tuning;
- quantization, export, delegate, operator;
- cold/warm latency, p50/p95, throughput, backpressure;
- RAG, structured output, provenance;
- shadow mode, drift, active learning, ablation.

## The decision rule for training

Do not ask “should we fine-tune?” in the abstract. Ask which measured ceiling is blocking the product:

```text
wrong or unusable frame
  -> improve capture selection

identifier visible but missed
  -> improve OCR/barcode/model-plate acquisition

correct product absent from candidates
  -> improve corpus, query construction, or embeddings

correct product retrieved but ranked below a sibling
  -> improve reranking or metric learning with hard negatives

confidence does not match correctness
  -> calibrate and adjust abstention

identity correct but retail evidence missing/stale
  -> improve retrieval sources and refresh policy

draft facts wrong despite correct evidence
  -> improve structured generation and validation

system accurate but feels slow
  -> profile the critical path, queueing, copies, network, and thermal behavior
```

That diagnostic discipline is the actual 80/20 skill.
