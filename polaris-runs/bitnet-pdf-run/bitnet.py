import torch
import torch.nn as nn

class BitLinear(nn.Module):
    def __init__(self, in_features, out_features):
        super(BitLinear, self).__init__()
        self.in_features = in_features
        self.out_features = out_features
        self.weight = nn.Parameter(torch.randn(out_features, in_features))
        self.bias = nn.Parameter(torch.zeros(out_features))

    def forward(self, x):
        # Binarization of weights
        binary_weight = torch.sign(self.weight)
        return nn.functional.linear(x, binary_weight, self.bias)

class BitNet(nn.Module):
    def __init__(self, num_classes):
        super(BitNet, self).__init__()
        self.layer1 = BitLinear(768, 768)  # Example dimensions
        self.layer2 = BitLinear(768, num_classes)

    def forward(self, x):
        x = self.layer1(x)
        x = torch.relu(x)
        x = self.layer2(x)
        return x

# Example usage:
if __name__ == '__main__':
    model = BitNet(num_classes=10)
    print(model)