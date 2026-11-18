"""Figures for the Research Studio test paper: a vector bar chart (PDF) and a raster line chart (PNG)."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams.update({"font.size": 9, "pdf.fonttype": 42})

# Fig. 1 — vector bar chart (accuracy per method on two datasets)
methods = ["FedAvg", "FedProx", "MOON", "Ours"]
cifar = [78.4, 79.1, 81.4, 83.5]
fmnist = [88.2, 88.9, 90.3, 91.7]
fig, ax = plt.subplots(figsize=(3.4, 2.3))
x = range(len(methods))
w = 0.38
ax.bar([i - w / 2 for i in x], cifar, w, label="CIFAR-10", color="#3346c8")
ax.bar([i + w / 2 for i in x], fmnist, w, label="FMNIST", color="#e0662b")
ax.set_xticks(list(x))
ax.set_xticklabels(methods)
ax.set_ylim(70, 95)
ax.set_ylabel("Accuracy (%)")
ax.legend(loc="upper left", frameon=False, ncol=2)
fig.tight_layout()
fig.savefig("fig_accuracy.pdf")

# Fig. 2 — raster line chart (accuracy vs. number of clients)
clients = [10, 20, 50, 100]
ours = [84.1, 83.5, 82.0, 80.2]
base = [80.3, 78.4, 75.1, 71.9]
fig, ax = plt.subplots(figsize=(3.4, 2.3), dpi=200)
ax.plot(clients, ours, "o-", color="#12a58a", label="Ours")
ax.plot(clients, base, "s--", color="#b33dc6", label="FedAvg")
ax.set_xlabel("Number of clients")
ax.set_ylabel("Accuracy (%)")
ax.set_ylim(70, 86)
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig("fig_clients.png")
print("ok")
