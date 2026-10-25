# Unsloth Qwen 3.5 4B SFT — P31 GenUI Catalog-Conditioned Training
# Paste this into a Google Colab notebook (free T4 GPU).
# Config: r=8, 4 epochs, 8192 context, effective batch 8
# Dataset: Perturbed-catalog A2UI (600 examples, 7-component catalog)
# Export: GGUF Q4_K_M for Ollama/llama.cpp

# ── Cell 1: Install Unsloth ──────────────────────────────────────────────────
# !pip install unsloth unsloth_zoo transformers>=5.0.0

# ── Cell 2: Load model (bf16 LoRA, NO QLoRA) ────────────────────────────────
from unsloth import FastLanguageModel
import torch

max_seq_length = 8192  # paper's validated context
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen3.5-4B",
    max_seq_length=max_seq_length,
    load_in_4bit=False,     # QLoRA NOT recommended for Qwen3.5
    load_in_16bit=True,     # bf16 LoRA
    full_finetuning=False,
)

# ── Cell 3: Attach LoRA (paper's recipe: r=8, 4 epochs) ─────────────────────
model = FastLanguageModel.get_peft_model(
    model,
    r=8,
    lora_alpha=8,
    lora_dropout=0,
    bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                    "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
    random_state=3407,
    max_seq_length=max_seq_length,
)

# ── Cell 4: Load dataset ─────────────────────────────────────────────────────
from datasets import load_dataset

# Option A: Load from GitHub raw URL
# dataset = load_dataset("json", data_files={"train": "https://raw.githubusercontent.com/.../sft-dataset.jsonl"}, split="train")

# Option B: Load from Google Drive (after uploading sft-dataset.jsonl)
# from google.colab import drive
# drive.mount('/content/drive')
# dataset = load_dataset("json", data_files={"train": "/content/drive/MyDrive/sft-dataset.jsonl"}, split="train")

# Option C: Load from HuggingFace
# dataset = load_dataset("your-username/p31-genui-sft", split="train")

# Format: each example has {prompt, catalog, a2ui} → convert to "text" column
def format_example(example):
    system = "You are an A2UI v0.9 generator. Given a user request and a component catalog, emit A2UI JSONL messages.\n\nCatalog:\n" + str(example["catalog"])
    user = example["prompt"]
    assistant = str(example["a2ui"])
    return {"text": f"<|system|>\n{system}\n<|user|>\n{user}\n<|assistant|>\n{assistant}"}

dataset = dataset.map(format_example)

# ── Cell 5: Train (4 epochs, effective batch 8) ──────────────────────────────
from trl import SFTTrainer, SFTConfig

trainer = SFTTrainer(
    model=model,
    train_dataset=dataset,
    tokenizer=tokenizer,
    args=SFTConfig(
        max_seq_length=max_seq_length,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,  # effective batch 8
        num_train_epochs=4,
        warmup_steps=10,
        logging_steps=1,
        output_dir="outputs_qwen35_4b_genui",
        optim="adamw_8bit",
        seed=3407,
        dataset_num_proc=1,
        save_strategy="epoch",
        save_total_limit=4,
    ),
)

trainer.train()

# ── Cell 6: Checkpoint to Drive ───────────────────────────────────────────────
# import shutil
# shutil.copytree("outputs_qwen35_4b_genui", "/content/drive/MyDrive/p31-genui-checkpoint")

# ── Cell 7: Export to GGUF Q4_K_M ────────────────────────────────────────────
model.save_pretrained_gguf("p31-genui-4b", tokenizer, quantization_method="q4_k_m")
model.push_to_hub_gguf("your-username/p31-genui-4b", tokenizer, quantization_method="q4_k_m")

# ── Cell 8: Test inference ───────────────────────────────────────────────────
FastLanguageModel.for_inference(model)
inputs = tokenizer("Create a dashboard with a heading Revenue and a StatCard showing 42,000", return_tensors="pt").to("cuda")
outputs = model.generate(**inputs, max_new_tokens=512)
print(tokenizer.decode(outputs[0], skip_special_tokens=True))