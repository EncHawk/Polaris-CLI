import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from bitnet import BitNet

# Placeholder for dataset
class DummyDataset(torch.utils.data.Dataset):
    def __init__(self, size):
        self.size = size

    def __len__(self):
        return self.size

    def __getitem__(self, idx):
        return torch.randn(768), torch.randint(0, 10, (1,)).item()  # Example data

if __name__ == '__main__':
    dataset = DummyDataset(1000)
    dataloader = DataLoader(dataset, batch_size=32, shuffle=True)
    model = BitNet(num_classes=10)
    optimizer = torch.optim.Adam(model.parameters())
    criterion = nn.CrossEntropyLoss()

    for epoch in range(10):
        for inputs, labels in dataloader:
            optimizer.zero_grad()
            outputs = model(inputs)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()
            print(f'Epoch [{epoch+1}/10], Loss: {loss.item():.4f}')