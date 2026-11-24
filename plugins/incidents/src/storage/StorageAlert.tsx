import Alert from '@mui/material/Alert';
import { styled } from '@mui/material/styles';

export const StorageAlert = styled(Alert)(({ theme }) => ({
  color: theme.palette.text.primary,
}));
